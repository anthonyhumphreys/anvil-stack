import { useEffect, useRef, useState } from 'react';
import {
  BrainCircuit,
  CheckCircle,
  ChevronDown,
  ChevronUp,
  ClipboardList,
  FileText,
  GitFork,
  Loader2,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import { useBrand } from '../../contexts/BrandContext';
import type {
  AgentProvider,
  AppSettings,
  DevinCliStatus,
  LlmGatewayStatus,
} from '../../../shared/types';
import { OnboardingPreviewBar } from './OnboardingPreviewBar';
import { selectPrimaryAgentProvider } from '../../utils/agent-provider-settings';
import { CodexRuntimeSetup } from '../settings/CodexRuntimeSetup';

type TestStatus = 'idle' | 'testing' | 'ok' | 'error';

interface ConnectorSetupOverlayProps {
  onContinue: () => void;
  preview?: boolean;
  onExitPreview?: () => void;
}

export function ConnectorSetupOverlay({
  onContinue,
  preview = false,
  onExitPreview,
}: ConnectorSetupOverlayProps) {
  const brand = useBrand();
  const [settings, setSettings] = useState<Partial<AppSettings>>({});
  const [expandedCard, setExpandedCard] = useState<string | null>(null);
  const [llmStatus, setLlmStatus] = useState<TestStatus>('idle');
  const [llmGatewayConnecting, setLlmGatewayConnecting] = useState(false);
  const [llmGatewayStatus, setLlmGatewayStatus] = useState<LlmGatewayStatus | null>(null);
  const [devinStatus, setDevinStatus] = useState<DevinCliStatus | null>(null);
  const [devinSigningIn, setDevinSigningIn] = useState(false);
  const gatewayRequestId = useRef(0);
  const [wiStatus, setWiStatus] = useState<TestStatus>('idle');
  const [gitStatus, setGitStatus] = useState<TestStatus>('idle');
  const [confluenceStatus, setConfluenceStatus] = useState<TestStatus>('idle');
  const [testError, setTestError] = useState<string | null>(null);
  const [configured, setConfigured] = useState<Set<string>>(new Set());
  const [gitProvider, setGitProvider] = useState<'github' | 'ado'>('github');
  const [ghUsername, setGhUsername] = useState<string | null>(null);
  const [ghError, setGhError] = useState<string | null>(null);

  useEffect(() => {
    window.anvil.repo.ghAuthStatus().then((status) => {
      if (status.authenticated) {
        setGhUsername(status.username ?? null);
      } else {
        setGhError(status.error ?? null);
      }
    });
  }, []);

  const update = (key: keyof AppSettings, value: string) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
  };

  const selectLlmProvider = (provider: AgentProvider) => {
    gatewayRequestId.current += 1;
    setSettings((current) => selectPrimaryAgentProvider(current, provider));
    setLlmStatus('idle');
    if (provider === 'llmgateway' && !preview) {
      const requestId = gatewayRequestId.current;
      void window.anvil.settings
        .getLlmGatewayStatus()
        .then((status) => {
          if (requestId !== gatewayRequestId.current) return;
          setLlmGatewayStatus(status);
          if (status.models.length > 0) {
            setSettings((current) => ({
              ...current,
              openaiModel:
                current.openaiModel &&
                status.models.some((model) => model.id === current.openaiModel)
                  ? current.openaiModel
                  : status.models[0].id,
            }));
          }
        })
        .catch(() => undefined);
    }
    if (provider === 'devin' && !preview) {
      void refreshDevinStatus();
    }
  };

  const refreshDevinStatus = () =>
    window.anvil.settings
      .getDevinStatus()
      .then(setDevinStatus)
      .catch(() => undefined);

  const startDevinLogin = () => {
    if (preview) return;
    setDevinSigningIn(true);
    setTestError(null);
    void window.anvil.settings
      .startDevinLogin()
      .then((result) => {
        if (!result.ok) setTestError(result.error ?? 'Devin sign-in did not complete.');
      })
      .then(refreshDevinStatus)
      .catch((err) => {
        setTestError(err instanceof Error ? err.message : 'Devin sign-in failed');
      })
      .finally(() => setDevinSigningIn(false));
  };

  const saveSettings = async () => {
    if (preview) return;
    try {
      await window.anvil.settings.update(settings);
    } catch (err) {
      // Persisting must not block connection tests.
      console.warn('[Connectors] save before test failed, continuing with test', err);
    }
  };

  const markConfigured = (id: string) => {
    setConfigured((prev) => new Set(prev).add(id));
  };

  const toggle = (id: string) => {
    setExpandedCard((prev) => (prev === id ? null : id));
  };

  // --- LLM ---
  const llmProvider = settings.llmProvider ?? 'codex';
  const selectGatewayBillingMode = (billingMode: AppSettings['llmGatewayBillingMode']) => {
    if (!billingMode || preview || llmGatewayConnecting) return;
    const requestId = ++gatewayRequestId.current;
    setSettings((current) => ({
      ...current,
      llmGatewayBillingMode: billingMode,
      openaiModel: undefined,
    }));
    setLlmGatewayStatus(null);
    setLlmStatus('idle');
    void window.anvil.settings
      .getLlmGatewayStatus(true, billingMode)
      .then((status) => {
        if (requestId !== gatewayRequestId.current) return;
        setLlmGatewayStatus(status);
        if (status.models.length > 0) {
          setSettings((current) => ({ ...current, openaiModel: status.models[0].id }));
        }
      })
      .catch((error) => {
        if (requestId !== gatewayRequestId.current) return;
        setTestError(error instanceof Error ? error.message : 'Failed to load gateway models');
      });
  };

  const connectLlmGateway = async () => {
    if (preview) return;
    const requestId = ++gatewayRequestId.current;
    setLlmGatewayConnecting(true);
    setTestError(null);
    try {
      const billingMode = settings.llmGatewayBillingMode ?? 'devpass';
      await window.anvil.settings.update({
        ...settings,
        llmProvider: 'llmgateway',
        llmGatewayBillingMode: billingMode,
      });
      const hasManualKey = Boolean(
        settings.llmGatewayApiKey && !settings.llmGatewayApiKey.startsWith('••'),
      );
      const status = hasManualKey
        ? await window.anvil.settings.getLlmGatewayStatus(true, billingMode)
        : await window.anvil.settings.connectLlmGateway(billingMode);
      if (requestId !== gatewayRequestId.current || settings.llmProvider !== 'llmgateway') return;
      setLlmGatewayStatus(status);
      const selectedModel = status.models.some((model) => model.id === settings.openaiModel)
        ? settings.openaiModel!
        : (status.models[0]?.id ?? '');
      setSettings((current) => ({
        ...current,
        llmGatewayApiKey: '••••••••',
        llmGatewayBillingMode: billingMode,
        openaiModel: selectedModel,
      }));
      if (status.credentialStatus === 'valid') {
        if (selectedModel) {
          await window.anvil.settings.update({ openaiModel: selectedModel });
        }
        setLlmStatus('ok');
        markConfigured('llm');
      } else {
        setLlmStatus('error');
        setTestError(status.error ?? 'LLMGateway did not validate the connection.');
      }
    } catch (error) {
      if (requestId !== gatewayRequestId.current) return;
      setLlmStatus('error');
      setTestError(error instanceof Error ? error.message : 'Failed to connect LLMGateway');
    } finally {
      if (requestId === gatewayRequestId.current) setLlmGatewayConnecting(false);
    }
  };
  const testLlm = async () => {
    if (llmProvider === 'llmgateway') return connectLlmGateway();
    setLlmStatus('testing');
    setTestError(null);
    await saveSettings();
    const result = await window.anvil.settings.testFoundryConnection();
    setLlmStatus(result.ok ? 'ok' : 'error');
    if (result.ok) markConfigured('llm');
    if (result.error) setTestError(result.error);
  };

  // --- Work Items ---
  const wiProvider = settings.workItemProvider ?? 'ado';
  const testWi = async () => {
    setWiStatus('testing');
    setTestError(null);
    try {
      await saveSettings();
      const result = await window.anvil.settings.testWorkItemProviderConnection();
      setWiStatus(result.ok ? 'ok' : 'error');
      if (result.ok) markConfigured('workitems');
      if (result.error) setTestError(result.error);
    } catch (err) {
      setWiStatus('error');
      setTestError(err instanceof Error ? err.message : 'Connection test failed');
    }
  };

  // --- Confluence ---
  const testConfluence = async () => {
    setConfluenceStatus('testing');
    setTestError(null);
    await saveSettings();
    try {
      const result = await window.anvil.settings.testConfluenceConnection();
      setConfluenceStatus(result.ok ? 'ok' : 'error');
      if (result.ok) markConfigured('confluence');
      if (result.error) setTestError(result.error);
    } catch (err) {
      setConfluenceStatus('error');
      setTestError(err instanceof Error ? err.message : 'Connection test failed');
    }
  };

  // --- Git Provider ---
  const saveGit = async () => {
    setGitStatus('testing');
    setTestError(null);
    await saveSettings();

    if (gitProvider === 'github') {
      const status = await window.anvil.repo.ghAuthStatus();
      if (status.authenticated) {
        setGhUsername(status.username ?? null);
        setGhError(null);
        setGitStatus('ok');
        markConfigured('git');
      } else {
        setGhError(status.error ?? null);
        setGitStatus('error');
        setTestError(status.error ?? 'Not authenticated');
      }
    } else {
      const hasAdo = !!settings.adoPat && !!settings.adoOrganizationUrl;
      if (hasAdo) {
        setGitStatus('ok');
        markConfigured('git');
      } else {
        setGitStatus('error');
        setTestError('Please enter your credentials');
      }
    }
  };

  return (
    <div className="flex h-screen items-center justify-center overflow-auto bg-bg-primary">
      <div className="titlebar-drag fixed inset-x-0 top-0 h-10" />
      {preview && onExitPreview && <OnboardingPreviewBar onExit={onExitPreview} />}
      <div className={`w-full max-w-lg space-y-4 px-6 ${preview ? 'py-24' : 'py-16'}`}>
        <div className="text-center">
          <h1 className="text-2xl font-bold text-accent">{brand.appName}</h1>
          <h2 className="mt-2 text-lg font-semibold text-text-primary">Connect Your Tools</h2>
          <p className="mt-1 text-sm text-text-secondary">
            Configure each service or skip to set up later in Settings.
          </p>
        </div>

        <div className="space-y-2">
          {/* LLM Provider */}
          <ConnectorCard
            id="llm"
            icon={BrainCircuit}
            title="Primary agent"
            description="Choose who starts new chats and app-level AI work"
            expanded={expandedCard === 'llm'}
            status={llmStatus}
            isConfigured={configured.has('llm')}
            onToggle={() => toggle('llm')}
            onSkip={() => {
              setExpandedCard(null);
              markConfigured('llm');
            }}
          >
            <div className="space-y-3">
              <p className="text-xs text-text-secondary">
                Choose the primary agent for new chats. You can activate more providers in Settings.
              </p>
              <div className="grid grid-cols-2 gap-2">
                <ProviderButton
                  label="Codex CLI"
                  active={llmProvider === 'codex'}
                  onClick={() => selectLlmProvider('codex')}
                />
                <ProviderButton
                  label="Cursor CLI"
                  active={llmProvider === 'cursor'}
                  onClick={() => selectLlmProvider('cursor')}
                />
                <ProviderButton
                  label="Devin CLI"
                  active={llmProvider === 'devin'}
                  onClick={() => selectLlmProvider('devin')}
                />
                <ProviderButton
                  label="OpenAI"
                  active={llmProvider === 'openai'}
                  onClick={() => selectLlmProvider('openai')}
                />
                <ProviderButton
                  label="Azure Foundry"
                  active={llmProvider === 'azure'}
                  onClick={() => selectLlmProvider('azure')}
                />
                <ProviderButton
                  label="LLMGateway"
                  active={llmProvider === 'llmgateway'}
                  onClick={() => selectLlmProvider('llmgateway')}
                />
              </div>
              {llmProvider === 'codex' && (
                <p className="text-xs text-text-tertiary">
                  Uses your local Codex CLI — no API key needed.
                </p>
              )}
              {llmProvider === 'cursor' && (
                <p className="text-xs text-text-tertiary">
                  Uses your local Cursor CLI login. Run <code>cursor-agent login</code> first.
                </p>
              )}
              {llmProvider === 'devin' && (
                <div className="space-y-2 rounded-md border border-border bg-bg-primary p-3">
                  <p className="text-xs text-text-tertiary">
                    Devin runs locally through the installed Devin CLI and your Devin account
                    sign-in — no API key needed.
                  </p>
                  {!devinStatus ? (
                    <p className="flex items-center gap-2 text-xs text-text-secondary">
                      <Loader2 size={12} className="animate-spin" /> Checking for the Devin CLI…
                    </p>
                  ) : !devinStatus.installed ? (
                    <div className="space-y-2">
                      <p className="text-xs text-warning">
                        Devin CLI was not detected on this machine.
                      </p>
                      <p className="text-xs text-text-tertiary">
                        Install it from <code>devin.ai/cli</code>, then check again.
                      </p>
                      <button
                        type="button"
                        onClick={() => void refreshDevinStatus()}
                        className="rounded-md border border-border px-2.5 py-1.5 text-xs text-text-secondary hover:bg-bg-tertiary"
                      >
                        Check again
                      </button>
                    </div>
                  ) : devinStatus.authenticated === false ? (
                    <div className="space-y-2">
                      <p className="text-xs text-text-secondary">
                        {devinStatus.version ?? 'Devin CLI installed'} — sign in to continue.
                      </p>
                      <button
                        type="button"
                        disabled={preview || devinSigningIn}
                        onClick={startDevinLogin}
                        className="inline-flex items-center gap-2 rounded-md bg-accent px-3 py-2 text-xs font-medium text-white disabled:opacity-50"
                      >
                        {devinSigningIn && <Loader2 size={13} className="animate-spin" />}
                        Sign in with Devin
                      </button>
                      <p className="text-xs text-text-tertiary">
                        Opens a browser login, same as running <code>devin auth login</code>.
                      </p>
                    </div>
                  ) : (
                    <p className="flex items-center gap-1.5 text-xs text-success">
                      <CheckCircle size={12} />
                      {devinStatus.version ?? 'Devin CLI installed'} · {devinStatus.models.length}{' '}
                      models detected
                      {devinStatus.defaultModel ? ` · default ${devinStatus.defaultModel}` : ''}
                    </p>
                  )}
                  {devinStatus?.error && <p className="text-xs text-error">{devinStatus.error}</p>}
                </div>
              )}
              {llmProvider === 'openai' && (
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
                    value={settings.openaiModel ?? 'gpt-5.6-sol'}
                    onChange={(v) => update('openaiModel', v)}
                    placeholder="gpt-5.6-sol"
                  />
                </>
              )}
              {llmProvider === 'llmgateway' && (
                <div className="space-y-3">
                  <div className="grid grid-cols-2 gap-2">
                    <ProviderButton
                      label="DevPass"
                      active={(settings.llmGatewayBillingMode ?? 'devpass') === 'devpass'}
                      disabled={llmGatewayConnecting}
                      onClick={() => selectGatewayBillingMode('devpass')}
                    />
                    <ProviderButton
                      label="Pay as you go"
                      active={settings.llmGatewayBillingMode === 'payg'}
                      disabled={llmGatewayConnecting}
                      onClick={() => selectGatewayBillingMode('payg')}
                    />
                  </div>
                  <button
                    type="button"
                    disabled={preview || llmGatewayConnecting}
                    onClick={() => void connectLlmGateway()}
                    className="inline-flex items-center gap-2 rounded-md bg-accent px-3 py-2 text-xs font-medium text-white disabled:opacity-50"
                  >
                    {llmGatewayConnecting && <Loader2 size={13} className="animate-spin" />}
                    {settings.llmGatewayApiKey && !settings.llmGatewayApiKey.startsWith('••')
                      ? 'Verify API key'
                      : 'Connect in browser'}
                  </button>
                  <CodexRuntimeSetup compact disabled={preview} />
                  <Field
                    label="API key (alternative)"
                    value={settings.llmGatewayApiKey ?? ''}
                    onChange={(value) => update('llmGatewayApiKey', value)}
                    type="password"
                    placeholder="llmgtwy_..."
                  />
                  <div className="space-y-1">
                    <label
                      htmlFor="onboarding-llmgateway-model"
                      className="block text-xs text-text-secondary"
                    >
                      Model
                    </label>
                    <select
                      id="onboarding-llmgateway-model"
                      value={settings.openaiModel ?? ''}
                      onChange={(event) => update('openaiModel', event.target.value)}
                      disabled={preview || !llmGatewayStatus?.models.length}
                      className="w-full rounded-md border border-border bg-bg-primary px-2.5 py-1.5 text-xs text-text-primary focus:border-accent focus:outline-none disabled:opacity-60"
                    >
                      {!llmGatewayStatus?.models.length && (
                        <option value="">Connect to load available models</option>
                      )}
                      {(llmGatewayStatus?.models ?? []).map((model) => (
                        <option key={model.id} value={model.id}>
                          {model.displayName} · {model.id}
                        </option>
                      ))}
                    </select>
                    <p className="text-xs text-text-tertiary">
                      Choose a model from the validated LLMGateway catalog.
                    </p>
                  </div>
                </div>
              )}
              {llmProvider === 'azure' && (
                <div className="rounded-md border border-border bg-bg-primary p-3 space-y-2">
                  <p className="text-xs text-text-primary">
                    Configure via{' '}
                    <code className="rounded bg-bg-tertiary px-1 py-0.5 font-mono text-text-primary">
                      ~/.codex/config.toml
                    </code>
                  </p>
                  <div className="rounded bg-bg-tertiary p-2 font-mono text-xs leading-relaxed space-y-0.5 overflow-x-auto">
                    <p>
                      <span className="text-text-secondary">model_provider</span>{' '}
                      <span className="text-text-tertiary">=</span>{' '}
                      <span className="text-success">"azure"</span>
                    </p>
                    <p />
                    <p>
                      <span className="text-text-tertiary">[model_providers.azure]</span>
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
                  <a
                    href="https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/codex?tabs=npm"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-block text-xs text-info hover:underline"
                  >
                    Full setup guide ↗
                  </a>
                </div>
              )}
              {llmProvider !== 'azure' && (
                <TestButton
                  status={llmStatus}
                  onClick={testLlm}
                  label="Test Connection"
                  disabled={preview}
                />
              )}
            </div>
          </ConnectorCard>

          {/* Work Items */}
          <ConnectorCard
            id="workitems"
            icon={ClipboardList}
            title="Work Items"
            description="Track tasks with ADO, Linear, or Jira"
            expanded={expandedCard === 'workitems'}
            status={wiStatus}
            isConfigured={configured.has('workitems')}
            onToggle={() => toggle('workitems')}
            onSkip={() => {
              setExpandedCard(null);
              markConfigured('workitems');
            }}
          >
            <div className="space-y-3">
              <div className="flex gap-2">
                <ProviderButton
                  label="Azure DevOps"
                  active={wiProvider === 'ado'}
                  onClick={() => update('workItemProvider', 'ado')}
                />
                <ProviderButton
                  label="Linear"
                  active={wiProvider === 'linear'}
                  onClick={() => update('workItemProvider', 'linear')}
                />
                <ProviderButton
                  label="Jira"
                  active={wiProvider === 'jira'}
                  onClick={() => update('workItemProvider', 'jira')}
                />
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
                    label="PAT"
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
                  <Field
                    label="Project Key"
                    value={settings.jiraProject ?? ''}
                    onChange={(v) => update('jiraProject', v)}
                    placeholder="ENG"
                  />
                  <Field
                    label="Email"
                    value={settings.jiraEmail ?? ''}
                    onChange={(v) => update('jiraEmail', v)}
                  />
                  <Field
                    label="API Token"
                    value={settings.jiraApiToken ?? ''}
                    onChange={(v) => update('jiraApiToken', v)}
                    type="password"
                  />
                </>
              )}
              <TestButton
                status={wiStatus}
                onClick={testWi}
                label="Test Connection"
                disabled={preview}
              />
            </div>
          </ConnectorCard>

          {/* Git Provider */}
          <ConnectorCard
            id="git"
            icon={GitFork}
            title="Git Provider"
            description="Browse and clone remote repos"
            expanded={expandedCard === 'git'}
            status={gitStatus}
            isConfigured={configured.has('git')}
            onToggle={() => toggle('git')}
            onSkip={() => {
              setExpandedCard(null);
              markConfigured('git');
            }}
          >
            <div className="space-y-3">
              <div className="flex gap-2">
                <ProviderButton
                  label="GitHub"
                  active={gitProvider === 'github'}
                  onClick={() => setGitProvider('github')}
                />
                <ProviderButton
                  label="Azure DevOps"
                  active={gitProvider === 'ado'}
                  onClick={() => setGitProvider('ado')}
                />
              </div>
              {gitProvider === 'github' && (
                <div className="rounded-md border border-border bg-bg-primary p-3">
                  {ghUsername ? (
                    <div className="flex items-center gap-2">
                      <CheckCircle size={14} className="text-success" />
                      <span className="text-xs text-text-primary">
                        Authenticated as{' '}
                        <span className="font-medium text-accent">{ghUsername}</span>
                      </span>
                    </div>
                  ) : (
                    <div className="space-y-1.5">
                      <p className="text-xs text-text-secondary">
                        GitHub uses the{' '}
                        <code className="rounded bg-bg-tertiary px-1 py-0.5 font-mono text-accent">
                          gh
                        </code>{' '}
                        CLI for authentication.
                      </p>
                      {ghError && (
                        <div className="flex items-center gap-1.5 text-xs text-warning">
                          <XCircle size={12} />
                          {ghError}
                        </div>
                      )}
                      <p className="text-[10px] text-text-tertiary">
                        Run{' '}
                        <code className="rounded bg-bg-tertiary px-1 py-0.5 font-mono text-accent">
                          gh auth login
                        </code>{' '}
                        in your terminal, then click Save.
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
                    label="Project"
                    value={settings.adoProject ?? ''}
                    onChange={(v) => update('adoProject', v)}
                  />
                  <Field
                    label="PAT"
                    value={settings.adoPat ?? ''}
                    onChange={(v) => update('adoPat', v)}
                    type="password"
                  />
                  <p className="text-xs text-text-tertiary">
                    Uses the same ADO credentials as Work Items if already configured.
                  </p>
                </>
              )}
              <TestButton status={gitStatus} onClick={saveGit} label="Save" disabled={preview} />
            </div>
          </ConnectorCard>

          {/* Confluence */}
          <ConnectorCard
            id="confluence"
            icon={FileText}
            title="Confluence"
            description="Search team docs and knowledge base"
            expanded={expandedCard === 'confluence'}
            status={confluenceStatus}
            isConfigured={configured.has('confluence')}
            onToggle={() => toggle('confluence')}
            onSkip={() => {
              setExpandedCard(null);
              markConfigured('confluence');
            }}
          >
            <div className="space-y-3">
              <Field
                label="Base URL"
                value={settings.confluenceBaseUrl ?? ''}
                onChange={(v) => update('confluenceBaseUrl', v)}
                placeholder="https://confluence.internal.company.com"
              />
              <Field
                label="Space Key"
                value={settings.confluenceSpaceKey ?? ''}
                onChange={(v) => update('confluenceSpaceKey', v)}
              />
              <Field
                label="PAT"
                value={settings.confluencePat ?? ''}
                onChange={(v) => update('confluencePat', v)}
                type="password"
              />
              <TestButton
                status={confluenceStatus}
                onClick={testConfluence}
                label="Test Connection"
                disabled={preview}
              />
            </div>
          </ConnectorCard>
        </div>

        {testError && (
          <div className="rounded-md border border-error/30 bg-error/10 px-3 py-2 text-xs text-error">
            {testError}
          </div>
        )}

        <div className="text-center">
          <button
            onClick={async () => {
              // Persist any settings the user entered before moving on
              await saveSettings();
              onContinue();
            }}
            className="rounded-lg bg-accent px-8 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-accent/90"
          >
            Continue
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function ConnectorCard({
  id,
  icon,
  title,
  description,
  expanded,
  status,
  isConfigured,
  onToggle,
  onSkip,
  children,
}: {
  id: string;
  icon: LucideIcon;
  title: string;
  description: string;
  expanded: boolean;
  status: TestStatus;
  isConfigured: boolean;
  onToggle: () => void;
  onSkip: () => void;
  children: React.ReactNode;
}) {
  const contentId = `${id}-connector-content`;
  const Icon = icon;

  return (
    <div
      className={`rounded-lg border bg-bg-secondary transition-colors ${expanded ? 'border-accent/50' : 'border-border'}`}
    >
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-3 px-4 py-3 text-left"
        aria-expanded={expanded}
        aria-controls={contentId}
      >
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-bg-tertiary text-text-secondary">
          <Icon size={16} aria-hidden="true" />
        </span>
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-text-primary">{title}</span>
            {isConfigured && status === 'ok' && <CheckCircle size={14} className="text-success" />}
            {isConfigured && status !== 'ok' && status !== 'error' && (
              <span className="text-[10px] text-text-tertiary">skipped</span>
            )}
          </div>
          <span className="text-xs text-text-tertiary">{description}</span>
        </div>
        {expanded ? (
          <ChevronUp size={16} className="text-text-tertiary" />
        ) : (
          <ChevronDown size={16} className="text-text-tertiary" />
        )}
      </button>
      {expanded && (
        <div id={contentId} className="border-t border-border px-4 pb-4 pt-3">
          {children}
          <div className="mt-3 text-right">
            <button
              type="button"
              onClick={onSkip}
              className="text-xs text-text-tertiary hover:text-text-secondary"
            >
              Skip for now
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function ProviderButton({
  label,
  active,
  disabled = false,
  onClick,
}: {
  label: string;
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`flex-1 rounded-md border px-2 py-1.5 text-xs font-medium transition-colors ${
        active
          ? 'border-accent bg-accent/10 text-accent'
          : 'border-border bg-bg-primary text-text-secondary hover:bg-bg-tertiary'
      } disabled:cursor-not-allowed disabled:opacity-50`}
    >
      {label}
    </button>
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
      <label className="block text-xs text-text-secondary">{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-md border border-border bg-bg-primary px-2.5 py-1.5 text-xs text-text-primary placeholder:text-text-tertiary focus:border-accent focus:outline-none"
      />
    </div>
  );
}

function TestButton({
  status,
  onClick,
  label,
  disabled = false,
}: {
  status: TestStatus;
  onClick: () => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled || status === 'testing'}
      title={disabled ? 'Connection tests are unavailable in preview mode' : undefined}
      className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs text-text-secondary transition-colors hover:border-text-tertiary hover:text-text-primary disabled:opacity-50"
    >
      {status === 'testing' && <Loader2 size={12} className="animate-spin" />}
      {status === 'ok' && <CheckCircle size={12} className="text-success" />}
      {status === 'error' && <XCircle size={12} className="text-error" />}
      {label}
    </button>
  );
}
