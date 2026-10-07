import { useEffect, useRef, useState } from 'react';
import { Loader2, Save } from 'lucide-react';
import type {
  AgentProvider,
  AppSettings,
  CodexCliStatus,
  CursorCliStatus,
  DevinCliStatus,
  LocalLlmCapabilities,
  LocalLlmProvider,
  LlmGatewayBillingMode,
  LlmGatewayStatus,
  ReasoningEffort,
} from '../../../../shared/types';
import {
  CODEX_MODEL_OPTIONS,
  CODEX_REASONING_EFFORTS,
  DEFAULT_CODEX_MODEL,
  resolveCodexReasoningEffort,
  type CodexModelOption,
} from '../../../../shared/codex-models';
import { useBrand } from '../../../contexts/BrandContext';
import { dispatchCodexSelectionChanged } from '../../../utils/codex-selection';
import { selectPrimaryAgentProvider } from '../../../utils/agent-provider-settings';
import { buildProviderModelOptions } from '../../../utils/chat-model-options';
import { Button } from '../../ui';
import { CodexRuntimeSetup } from '../CodexRuntimeSetup';
import { useSettingsContext } from '../SettingsContext';
import { PROVIDER_CREDENTIAL_KEYS } from '../settings-keys';
import {
  ButtonGrid,
  CapabilityChip,
  CredentialSaveControls,
  Field,
  ProviderButton,
  ReasoningButton,
  SettingsPanel,
  TestButton,
  type TestStatus,
} from '../settings-ui';

type CodexModelPickerOption = CodexModelOption & { source: 'docs' | 'cli' };

const AGENT_PROVIDER_OPTIONS: Array<{
  id: AgentProvider;
  label: string;
  description: string;
}> = [
  {
    id: 'codex',
    label: 'Codex CLI',
    description: 'Local Codex login, tools, skills, and app-server sessions.',
  },
  {
    id: 'cursor',
    label: 'Cursor CLI',
    description: 'Cursor models and agent tools through cursor-agent.',
  },
  {
    id: 'devin',
    label: 'Devin CLI',
    description: 'Devin models and agent tools through the local Devin CLI.',
  },
  {
    id: 'openai',
    label: 'OpenAI API',
    description: 'Direct API-key route for app utilities and Codex sessions.',
  },
  {
    id: 'azure',
    label: 'Azure AI Foundry',
    description: 'Azure-hosted models registered through your Codex configuration.',
  },
  {
    id: 'llmgateway',
    label: 'LLMGateway',
    description: 'DevPass or pay-as-you-go models through one gateway connection.',
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

function formatModelTokenLimit(tokens: number): string {
  return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(
    tokens,
  );
}

function formatModelPrice(price: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 }).format(price);
}

function AgentProviderManager({
  primaryProvider,
  enabledProviders,
  onSetPrimary,
  onToggle,
}: {
  primaryProvider: AgentProvider;
  enabledProviders: AgentProvider[];
  onSetPrimary: (provider: AgentProvider) => void;
  onToggle: (provider: AgentProvider) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Primary agent provider"
      className="overflow-hidden rounded-lg border border-border bg-bg-primary"
    >
      <div className="grid grid-cols-[minmax(0,1fr)_7rem_7rem] items-center border-b border-border-subtle bg-bg-secondary px-3 py-2 text-xs font-medium text-text-tertiary">
        <span>Provider</span>
        <span className="text-center">Primary</span>
        <span className="text-center">Available</span>
      </div>
      {AGENT_PROVIDER_OPTIONS.map((option, index) => {
        const isPrimary = primaryProvider === option.id;
        const isEnabled = enabledProviders.includes(option.id);
        return (
          <div
            key={option.id}
            className={`grid grid-cols-[minmax(0,1fr)_7rem_7rem] items-center gap-2 px-3 py-3 ${
              index > 0 ? 'border-t border-border-subtle' : ''
            }`}
          >
            <div className="min-w-0">
              <div className="text-sm font-medium text-text-primary">{option.label}</div>
              <div className="mt-0.5 text-xs text-text-tertiary">{option.description}</div>
            </div>
            <button
              type="button"
              role="radio"
              aria-checked={isPrimary}
              onClick={() => onSetPrimary(option.id)}
              className={`mx-auto inline-flex min-h-8 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors ${
                isPrimary
                  ? 'bg-accent/12 text-accent'
                  : 'text-text-secondary hover:bg-bg-tertiary hover:text-text-primary'
              }`}
            >
              <span
                className={`h-3 w-3 rounded-full border ${
                  isPrimary ? 'border-accent bg-accent' : 'border-text-tertiary'
                }`}
                aria-hidden="true"
              />
              {isPrimary ? 'Primary' : 'Make primary'}
            </button>
            <button
              type="button"
              aria-pressed={isEnabled}
              disabled={isPrimary}
              onClick={() => onToggle(option.id)}
              className={`mx-auto min-h-8 rounded-md px-2.5 text-xs font-medium transition-colors ${
                isEnabled
                  ? 'bg-success/10 text-success'
                  : 'bg-bg-secondary text-text-secondary hover:bg-bg-tertiary hover:text-text-primary'
              } disabled:cursor-default`}
              title={isPrimary ? 'The primary provider is always available.' : undefined}
            >
              {isPrimary ? 'Required' : isEnabled ? 'Active' : 'Inactive'}
            </button>
          </div>
        );
      })}
    </div>
  );
}

export function ProvidersCategory() {
  const { draft, reportError } = useSettingsContext();
  const brand = useBrand();
  const { settings } = draft;

  const [llmStatus, setLlmStatus] = useState<TestStatus>('idle');
  const [localLlmStatus, setLocalLlmStatus] = useState<TestStatus>('idle');
  const [localLlmCapabilities, setLocalLlmCapabilities] = useState<LocalLlmCapabilities | null>(
    null,
  );
  const [codexStatus, setCodexStatus] = useState<CodexCliStatus | null>(null);
  const [cursorStatus, setCursorStatus] = useState<CursorCliStatus | null>(null);
  const [devinStatus, setDevinStatus] = useState<DevinCliStatus | null>(null);
  const [devinSigningIn, setDevinSigningIn] = useState(false);
  const [llmGatewayStatus, setLlmGatewayStatus] = useState<LlmGatewayStatus | null>(null);
  const [llmGatewayConnecting, setLlmGatewayConnecting] = useState(false);
  const llmGatewayRequestId = useRef(0);
  const [agentMaxThreads, setAgentMaxThreads] = useState(6);
  const [agentMaxThreadsSaving, setAgentMaxThreadsSaving] = useState(false);
  const [agentMaxThreadsError, setAgentMaxThreadsError] = useState<string | null>(null);
  const [savingCredentialsForTest, setSavingCredentialsForTest] = useState(false);

  useEffect(() => {
    window.anvil.settings
      .getCodexStatus()
      .then((status) => {
        setCodexStatus(status);
        setAgentMaxThreads(status.agentMaxThreads ?? 6);
      })
      .catch(console.warn);
    window.anvil.settings.getCursorStatus().then(setCursorStatus).catch(console.warn);
    window.anvil.settings.getDevinStatus().then(setDevinStatus).catch(console.warn);
    window.anvil.settings.getLlmGatewayStatus().then(setLlmGatewayStatus).catch(console.warn);
    window.anvil.settings
      .getLocalLlmCapabilities()
      .then(setLocalLlmCapabilities)
      .catch(console.warn);
  }, []);

  const provider = settings.llmProvider ?? 'codex';
  const enabledProviders = [
    ...new Set<AgentProvider>([provider, ...(settings.enabledLlmProviders ?? [])]),
  ];

  const codexModelOptions = buildCodexModelOptions(codexStatus);
  const selectedModelId =
    settings.openaiModel ?? (provider === 'llmgateway' ? '' : DEFAULT_CODEX_MODEL);
  const selectedModel = codexModelOptions.find((model) => model.id === selectedModelId);
  const selectedLlmGatewayModel = llmGatewayStatus?.models.find(
    (model) => model.id === selectedModelId,
  );
  const reasoningOptions = selectedModel?.supportedReasoningEfforts?.length
    ? selectedModel.supportedReasoningEfforts
    : selectedLlmGatewayModel?.supportedReasoningEfforts.length
      ? selectedLlmGatewayModel.supportedReasoningEfforts
      : CODEX_REASONING_EFFORTS;
  const selectedReasoningEffort = resolveCodexReasoningEffort(
    selectedModelId,
    settings.reasoningLevel,
    provider === 'llmgateway' ? llmGatewayStatus?.models : codexStatus?.models,
  );
  const assistProvider = settings.threadAssistProvider ?? 'off';
  const assistAgentProvider = AGENT_PROVIDER_OPTIONS.some((option) => option.id === assistProvider)
    ? (assistProvider as AgentProvider)
    : null;
  const assistModelOptions = assistAgentProvider
    ? buildProviderModelOptions(
        assistAgentProvider,
        settings.threadAssistModel || null,
        codexStatus,
        cursorStatus,
        llmGatewayStatus,
        devinStatus,
      )
    : [];

  const announceSelection = (patch: Partial<AppSettings>) => {
    const merged = { ...settings, ...patch };
    const model = merged.openaiModel ?? (provider === 'llmgateway' ? '' : DEFAULT_CODEX_MODEL);
    if (!model) return;
    dispatchCodexSelectionChanged({
      model,
      reasoningEffort: resolveCodexReasoningEffort(
        model,
        merged.reasoningLevel,
        merged.llmProvider === 'llmgateway' ? llmGatewayStatus?.models : codexStatus?.models,
      ),
    });
  };

  const updateCodexModel = (modelId: string) => {
    const reasoningEffort = resolveCodexReasoningEffort(
      modelId,
      settings.reasoningLevel,
      provider === 'llmgateway' ? llmGatewayStatus?.models : codexStatus?.models,
    );
    const patch: Partial<AppSettings> = { openaiModel: modelId, reasoningLevel: reasoningEffort };
    draft.updateMany(patch);
    announceSelection(patch);
  };

  const updateReasoning = (effort: ReasoningEffort) => {
    draft.update('reasoningLevel', effort);
    announceSelection({ reasoningLevel: effort });
  };

  const setPrimaryProvider = (nextProvider: AgentProvider) => {
    const next = selectPrimaryAgentProvider(settings, nextProvider, {
      cursor: cursorStatus?.models.map((model) => model.id) ?? [],
      devin: devinStatus?.models.map((model) => model.id) ?? [],
    });
    draft.updateMany(next);
    announceSelection(next);
  };

  const toggleProvider = (providerId: AgentProvider) => {
    if (providerId === provider) return;
    const current = new Set(settings.enabledLlmProviders ?? [provider]);
    if (current.has(providerId)) current.delete(providerId);
    else current.add(providerId);
    current.add(provider);
    draft.update('enabledLlmProviders', [...current]);
  };

  const saveAgentMaxThreads = async () => {
    setAgentMaxThreadsSaving(true);
    setAgentMaxThreadsError(null);
    try {
      const status = await window.anvil.settings.setCodexAgentMaxThreads(agentMaxThreads);
      setCodexStatus(status);
      setAgentMaxThreads(status.agentMaxThreads ?? agentMaxThreads);
    } catch (err) {
      setAgentMaxThreadsError(
        err instanceof Error ? err.message : 'Failed to update the Codex agent limit.',
      );
    } finally {
      setAgentMaxThreadsSaving(false);
    }
  };

  /** Save only this panel's credential fields before a connection test (ST2). */
  const saveCredentialsForTest = async () => {
    setSavingCredentialsForTest(true);
    try {
      await draft.flushAutosave();
      const dirty = PROVIDER_CREDENTIAL_KEYS.filter((key) => draft.dirtyKeys.has(key));
      if (dirty.length > 0) await draft.saveKeys(dirty);
    } finally {
      setSavingCredentialsForTest(false);
    }
  };

  const testLlm = async () => {
    setLlmStatus('testing');
    reportError(null);
    await saveCredentialsForTest();
    const result = await window.anvil.settings.testFoundryConnection();
    setLlmStatus(result.ok ? 'ok' : 'error');
    if (result.error) reportError(result.error);
  };

  const testLocalLlm = async () => {
    setLocalLlmStatus('testing');
    reportError(null);
    await draft.flushAutosave();
    const result = await window.anvil.settings.testLocalLlm();
    setLocalLlmStatus(result.ok ? 'ok' : 'error');
    if (result.error) reportError(result.error);
    // Re-probe capabilities so backend/license state stays current after a test.
    window.anvil.settings
      .getLocalLlmCapabilities()
      .then(setLocalLlmCapabilities)
      .catch(console.warn);
  };

  const connectLlmGateway = async (billingMode: LlmGatewayBillingMode) => {
    const requestId = ++llmGatewayRequestId.current;
    setLlmGatewayConnecting(true);
    reportError(null);
    try {
      const status = await window.anvil.settings.connectLlmGateway(billingMode);
      if (requestId !== llmGatewayRequestId.current) return;
      setLlmGatewayStatus(status);
      draft.applyPersisted({
        llmGatewayApiKey: '••••••••',
        llmGatewayBillingMode: billingMode,
      });
    } catch (error) {
      if (requestId === llmGatewayRequestId.current) {
        reportError(error instanceof Error ? error.message : 'Failed to connect LLMGateway');
      }
    } finally {
      if (requestId === llmGatewayRequestId.current) setLlmGatewayConnecting(false);
    }
  };

  const selectLlmGatewayBillingMode = (billingMode: LlmGatewayBillingMode) => {
    if (llmGatewayConnecting) return;
    const requestId = ++llmGatewayRequestId.current;
    draft.updateMany({ llmGatewayBillingMode: billingMode, openaiModel: undefined }, 'manual');
    setLlmGatewayStatus(null);
    void window.anvil.settings
      .getLlmGatewayStatus(true, billingMode)
      .then((status) => {
        if (requestId === llmGatewayRequestId.current) setLlmGatewayStatus(status);
      })
      .catch((error) => {
        if (requestId === llmGatewayRequestId.current) {
          reportError(error instanceof Error ? error.message : 'Failed to load LLMGateway models');
        }
      });
  };

  const disconnectLlmGateway = async () => {
    const requestId = ++llmGatewayRequestId.current;
    setLlmGatewayConnecting(true);
    reportError(null);
    try {
      const status = await window.anvil.settings.disconnectLlmGateway();
      if (requestId !== llmGatewayRequestId.current) return;
      setLlmGatewayStatus(status);
      draft.applyPersisted({ llmGatewayApiKey: undefined });
    } catch (error) {
      if (requestId === llmGatewayRequestId.current) {
        reportError(error instanceof Error ? error.message : 'Failed to disconnect LLMGateway');
      }
    } finally {
      if (requestId === llmGatewayRequestId.current) setLlmGatewayConnecting(false);
    }
  };

  const startDevinLogin = () => {
    setDevinSigningIn(true);
    void window.anvil.settings
      .startDevinLogin()
      .then(() => window.anvil.settings.getDevinStatus())
      .then(setDevinStatus)
      .catch(console.warn)
      .finally(() => setDevinSigningIn(false));
  };

  return (
    <>
      <SettingsPanel
        panelId="agent-providers"
        title="Agent providers"
        description="Choose the primary agent for new chats, then activate any additional providers that workflows may use."
        saveKeys={['llmProvider', 'enabledLlmProviders', ...PROVIDER_CREDENTIAL_KEYS]}
      >
        <AgentProviderManager
          primaryProvider={provider}
          enabledProviders={enabledProviders}
          onSetPrimary={setPrimaryProvider}
          onToggle={toggleProvider}
        />
        <p className="text-xs text-text-tertiary">
          Primary controls new chats and app-level AI tasks. Active providers can be assigned
          independently to workflow steps; agents can also invoke their CLIs from prompts when
          appropriate.
        </p>

        {enabledProviders.includes('codex') && (
          <p className="text-sm text-text-secondary">
            Codex CLI uses your local ChatGPT sign-in and app-server configuration.
          </p>
        )}

        {enabledProviders.includes('cursor') && (
          <p className="text-sm text-text-secondary">
            Cursor CLI uses <code>cursor-agent acp</code> for chat and the local Cursor login.
            Install Cursor CLI and run <code>cursor-agent login</code> before use.
          </p>
        )}

        {enabledProviders.includes('devin') && (
          <div className="space-y-3 rounded-md border border-border bg-bg-primary p-4">
            <p className="text-sm text-text-secondary">
              Devin runs locally through the installed Devin CLI (<code>devin acp</code>) and your
              Devin sign-in.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              {devinStatus?.installed && devinStatus.authenticated === false && (
                <Button disabled={devinSigningIn} onClick={startDevinLogin}>
                  {devinSigningIn && <Loader2 size={14} className="animate-spin" />}
                  Sign in with Devin
                </Button>
              )}
              {!devinStatus?.installed && (
                <Button
                  variant="secondary"
                  onClick={() =>
                    void window.anvil.settings
                      .getDevinStatus()
                      .then(setDevinStatus)
                      .catch(console.warn)
                  }
                >
                  Check again
                </Button>
              )}
              <span className="text-xs text-text-tertiary">
                {!devinStatus
                  ? 'Checking for the Devin CLI…'
                  : !devinStatus.installed
                    ? 'Devin CLI was not detected. Install it, then check again.'
                    : devinStatus.authenticated === false
                      ? `${devinStatus.version ?? 'Devin CLI installed'} · sign-in required — the button opens a browser login (equivalent to devin auth login).`
                      : `${devinStatus.version ?? 'Devin CLI installed'} · ${
                          devinStatus.models.length
                        } models detected`}
              </span>
            </div>
            {devinStatus?.error && <p className="text-xs text-error">{devinStatus.error}</p>}
          </div>
        )}

        {enabledProviders.includes('openai') && (
          <Field
            label="API Key"
            value={settings.openaiApiKey ?? ''}
            onChange={(v) => draft.update('openaiApiKey', v)}
            type="password"
            placeholder="sk-..."
            saveKey="openaiApiKey"
          />
        )}

        {enabledProviders.includes('llmgateway') && (
          <div className="space-y-4 rounded-md border border-border bg-bg-primary p-4">
            <div>
              <p className="text-sm font-medium text-text-primary">LLMGateway account</p>
              <p className="mt-1 text-xs text-text-tertiary">
                Browser login mints a gateway key for Anvil and stores it with Electron&apos;s
                encrypted credential storage.
              </p>
            </div>
            <ButtonGrid>
              <ProviderButton
                label="DevPass"
                description="Use subscription billing and canonical model IDs"
                active={(settings.llmGatewayBillingMode ?? 'devpass') === 'devpass'}
                disabled={llmGatewayConnecting}
                onClick={() => selectLlmGatewayBillingMode('devpass')}
              />
              <ProviderButton
                label="Pay as you go"
                description="Use gateway credits and provider-pinned model IDs"
                active={settings.llmGatewayBillingMode === 'payg'}
                disabled={llmGatewayConnecting}
                onClick={() => selectLlmGatewayBillingMode('payg')}
              />
            </ButtonGrid>
            <div className="flex flex-wrap items-center gap-3">
              <Button
                disabled={llmGatewayConnecting}
                onClick={() => void connectLlmGateway(settings.llmGatewayBillingMode ?? 'devpass')}
              >
                {llmGatewayConnecting && <Loader2 size={14} className="animate-spin" />}
                {llmGatewayStatus?.connected ? 'Reconnect' : 'Connect in browser'}
              </Button>
              {llmGatewayStatus && llmGatewayStatus.credentialStatus !== 'missing' && (
                <Button
                  variant="secondary"
                  disabled={llmGatewayConnecting}
                  onClick={() => void disconnectLlmGateway()}
                >
                  Remove from Anvil
                </Button>
              )}
              <span className="text-xs text-text-tertiary">
                {llmGatewayStatus?.connected && llmGatewayStatus.credentialStatus === 'valid'
                  ? `Connected · ${llmGatewayStatus.models.length} available models`
                  : llmGatewayStatus?.credentialStatus === 'invalid'
                    ? 'Credentials need attention'
                    : 'Not connected'}
              </span>
            </div>
            <CodexRuntimeSetup />
            <Field
              label="API key (alternative)"
              value={settings.llmGatewayApiKey ?? ''}
              onChange={(value) => draft.update('llmGatewayApiKey', value)}
              type="password"
              placeholder="llmgtwy_..."
              saveKey="llmGatewayApiKey"
            />
            {llmGatewayStatus?.error && (
              <p className="text-xs text-error">{llmGatewayStatus.error}</p>
            )}
          </div>
        )}

        {enabledProviders.includes('azure') && (
          <div className="rounded-md border border-border bg-bg-primary p-4 space-y-3">
            <p className="text-sm text-text-primary">
              Azure AI Foundry is configured through the Codex CLI&apos;s{' '}
              <code className="rounded bg-bg-tertiary px-1.5 py-0.5 text-xs font-mono text-text-primary">
                ~/.codex/config.toml
              </code>
            </p>
            <div className="rounded-md bg-bg-tertiary p-3 font-mono text-xs leading-relaxed space-y-0.5 overflow-x-auto">
              <p className="text-text-tertiary select-none"># ~/.codex/config.toml</p>
              <p>
                <span className="text-text-secondary">model</span>{' '}
                <span className="text-text-tertiary">=</span>{' '}
                <span className="text-success">&quot;gpt-5.6-sol&quot;</span>{' '}
                <span className="text-text-tertiary">
                  # Replace with your actual Azure model deployment name
                </span>
              </p>
              <p>
                <span className="text-text-secondary">model_provider</span>{' '}
                <span className="text-text-tertiary">=</span>{' '}
                <span className="text-success">&quot;azure&quot;</span>
              </p>
              <p>
                <span className="text-text-secondary">model_reasoning_effort</span>{' '}
                <span className="text-text-tertiary">=</span>{' '}
                <span className="text-success">&quot;medium&quot;</span>
              </p>
              <p />
              <p>
                <span className="text-text-tertiary">[model_providers.azure]</span>
              </p>
              <p>
                <span className="text-text-secondary">name</span>{' '}
                <span className="text-text-tertiary">=</span>{' '}
                <span className="text-success">&quot;Azure OpenAI&quot;</span>
              </p>
              <p>
                <span className="text-text-secondary">base_url</span>{' '}
                <span className="text-text-tertiary">=</span>{' '}
                <span className="text-success">
                  &quot;https://your-resource.cognitiveservices.azure.com/openai/v1&quot;
                </span>
              </p>
              <p>
                <span className="text-text-secondary">env_key</span>{' '}
                <span className="text-text-tertiary">=</span>{' '}
                <span className="text-success">&quot;AZURE_OPENAI_API_KEY&quot;</span>
              </p>
              <p>
                <span className="text-text-secondary">wire_api</span>{' '}
                <span className="text-text-tertiary">=</span>{' '}
                <span className="text-success">&quot;responses&quot;</span>
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

        <CredentialSaveControls keys={PROVIDER_CREDENTIAL_KEYS} />

        {provider !== 'azure' && (
          <TestButton
            status={llmStatus}
            onClick={testLlm}
            savingCredentials={savingCredentialsForTest}
          />
        )}
      </SettingsPanel>

      <SettingsPanel
        panelId="model"
        title="Model & reasoning"
        description="Primary model and reasoning effort for the active provider."
        saveKeys={['openaiModel', 'reasoningLevel']}
        autosave
      >
        {provider === 'cursor' && (
          <div className="space-y-2 rounded-md border border-border bg-bg-primary p-4">
            <label className="block text-sm text-text-secondary">Primary Cursor model</label>
            <input
              list="settings-cursor-models"
              value={settings.openaiModel ?? 'auto'}
              onChange={(event) => draft.update('openaiModel', event.target.value)}
              className="w-full rounded-md border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary outline-none focus:border-accent"
            />
            <datalist id="settings-cursor-models">
              {(cursorStatus?.models ?? []).map((model) => (
                <option key={model.id} value={model.id}>
                  {model.label}
                </option>
              ))}
            </datalist>
            <p className="text-xs text-text-tertiary">
              {cursorStatus?.installed
                ? `${cursorStatus.version ?? 'Cursor CLI installed'} · ${
                    cursorStatus.models.length
                  } models detected`
                : 'Cursor CLI was not detected. Install it or enter a model id manually.'}
            </p>
          </div>
        )}

        {provider === 'devin' && (
          <div className="space-y-2 rounded-md border border-border bg-bg-primary p-4">
            <label className="block text-sm text-text-secondary">Primary Devin model</label>
            <input
              list="settings-devin-models"
              value={settings.openaiModel ?? 'auto'}
              onChange={(event) => draft.update('openaiModel', event.target.value)}
              className="w-full rounded-md border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary outline-none focus:border-accent"
            />
            <datalist id="settings-devin-models">
              <option value="auto">Auto (Devin default)</option>
              {(devinStatus?.models ?? []).map((model) => (
                <option key={model.id} value={model.id}>
                  {model.label}
                </option>
              ))}
            </datalist>
            <p className="text-xs text-text-tertiary">
              {devinStatus?.installed
                ? `${devinStatus.version ?? 'Devin CLI installed'} · ${
                    devinStatus.models.length
                  } models detected${
                    devinStatus.defaultModel ? ` · default: ${devinStatus.defaultModel}` : ''
                  }`
                : 'Devin CLI was not detected. Install it or enter a model id manually.'}
            </p>
          </div>
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
                      Boolean(codexStatus.webSearchMode) && codexStatus.webSearchMode !== 'disabled'
                    }
                  />
                </div>
              )}
              <div className="mt-4 flex items-end gap-3">
                <div className="min-w-0 flex-1">
                  <label
                    htmlFor="codex-agent-max-threads"
                    className="block text-sm text-text-secondary"
                  >
                    Maximum concurrent agents
                  </label>
                  <input
                    id="codex-agent-max-threads"
                    type="number"
                    min={1}
                    max={64}
                    step={1}
                    value={agentMaxThreads}
                    onChange={(event) => setAgentMaxThreads(Number(event.target.value))}
                    className="mt-1 w-full rounded-md border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary outline-none focus:border-accent"
                  />
                </div>
                <Button
                  variant="secondary"
                  onClick={saveAgentMaxThreads}
                  disabled={
                    agentMaxThreadsSaving ||
                    !Number.isInteger(agentMaxThreads) ||
                    agentMaxThreads < 1 ||
                    agentMaxThreads > 64
                  }
                >
                  {agentMaxThreadsSaving ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : (
                    <Save size={14} />
                  )}
                  Apply
                </Button>
              </div>
              <p className="mt-1 text-xs text-text-tertiary">
                Writes <code>[agents].max_threads</code> in the active Codex config.toml. The
                primary agent counts toward this limit.
              </p>
              {agentMaxThreadsError && (
                <p className="mt-1 text-xs text-error">{agentMaxThreadsError}</p>
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
                      <span className="rounded-full bg-success/10 px-2 py-0.5 text-eyebrow uppercase text-success">
                        Recommended
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-xs text-text-tertiary">{model.description}</p>
                  {model.source === 'cli' && (
                    <p className="mt-2 text-eyebrow uppercase text-text-tertiary">
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
                    onClick={() => updateReasoning(effort)}
                  />
                ))}
              </div>
              <p className="text-xs text-text-tertiary">
                Max gives one task more depth. Ultra uses subagents for work that can split into
                meaningful parts.
              </p>
            </div>
          </div>
        )}

        {provider === 'llmgateway' && (
          <div className="space-y-4 rounded-md border border-border bg-bg-primary p-4">
            <div className="space-y-1">
              <label className="block text-sm text-text-secondary">LLMGateway model</label>
              <select
                value={selectedModelId}
                onChange={(event) => updateCodexModel(event.target.value)}
                className="w-full rounded-md border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary outline-none focus:border-accent"
              >
                {!selectedModelId && (
                  <option value="" disabled>
                    Select a gateway model
                  </option>
                )}
                {!llmGatewayStatus?.models.some((model) => model.id === selectedModelId) && (
                  <option value={selectedModelId}>{selectedModelId}</option>
                )}
                {(llmGatewayStatus?.models ?? []).map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.displayName} - {model.id}
                  </option>
                ))}
              </select>
              <p className="text-xs text-text-tertiary">
                Models come from the{' '}
                {settings.llmGatewayBillingMode === 'payg'
                  ? 'provider-pinned pay-as-you-go'
                  : 'canonical DevPass'}{' '}
                catalog. Only models with tool calling are shown.
              </p>
              {selectedLlmGatewayModel && (
                <div className="space-y-1 text-xs text-text-tertiary">
                  {selectedLlmGatewayModel.description && (
                    <p>{selectedLlmGatewayModel.description}</p>
                  )}
                  <p>
                    {selectedLlmGatewayModel.contextWindow
                      ? `${formatModelTokenLimit(selectedLlmGatewayModel.contextWindow)} context`
                      : 'Context limit unavailable'}
                    {selectedLlmGatewayModel.maxOutputTokens
                      ? ` · ${formatModelTokenLimit(selectedLlmGatewayModel.maxOutputTokens)} max output`
                      : ''}
                    {selectedLlmGatewayModel.inputPrice !== undefined &&
                    selectedLlmGatewayModel.outputPrice !== undefined
                      ? ` · $${formatModelPrice(selectedLlmGatewayModel.inputPrice)} input / $${formatModelPrice(selectedLlmGatewayModel.outputPrice)} output per 1M tokens`
                      : ''}
                  </p>
                </div>
              )}
            </div>
            <div className="space-y-1">
              <label className="block text-sm text-text-secondary">Reasoning effort</label>
              <div className="grid gap-2 sm:grid-cols-4">
                {reasoningOptions.map((effort) => (
                  <ReasoningButton
                    key={effort}
                    label={formatReasoningLabel(effort)}
                    description={describeReasoningEffort(effort)}
                    active={selectedReasoningEffort === effort}
                    onClick={() => updateReasoning(effort)}
                  />
                ))}
              </div>
            </div>
          </div>
        )}
      </SettingsPanel>

      <SettingsPanel
        panelId="local-model"
        title="Local model"
        description="Route simple, self-contained prompts through a local model, then fall back to the selected backend when the classifier decides tools or deeper reasoning are needed."
        saveKeys={[
          'localLlmMode',
          'localLlmProvider',
          'ollamaEndpoint',
          'ollamaModel',
          'lmStudioEndpoint',
          'lmStudioModel',
        ]}
        autosave
      >
        <ButtonGrid>
          <ProviderButton
            label="Off"
            description="Always use selected backend"
            active={(settings.localLlmMode ?? 'off') === 'off'}
            onClick={() => draft.update('localLlmMode', 'off')}
          />
          <ProviderButton
            label="Prefer simple"
            description="Try local model for small helper prompts"
            active={settings.localLlmMode === 'prefer-simple'}
            onClick={() => draft.update('localLlmMode', 'prefer-simple')}
          />
        </ButtonGrid>

        <div className="space-y-2">
          <label className="block text-sm text-text-secondary">Provider</label>
          <ButtonGrid>
            {(localLlmCapabilities?.providers ?? ['ollama', 'lm-studio']).map((providerId) => (
              <ProviderButton
                key={providerId}
                label={
                  providerId === 'apple'
                    ? 'Apple Intelligence'
                    : providerId === 'ollama'
                      ? 'Ollama'
                      : 'LM Studio'
                }
                description={
                  providerId === 'apple'
                    ? 'Private on-device Foundation Models'
                    : providerId === 'ollama'
                      ? 'OpenAI-compatible Ollama server'
                      : 'OpenAI-compatible LM Studio server'
                }
                active={settings.localLlmProvider === providerId}
                onClick={() => {
                  draft.update('localLlmProvider', providerId as LocalLlmProvider);
                  setLocalLlmStatus('idle');
                }}
              />
            ))}
          </ButtonGrid>
        </div>

        {settings.localLlmProvider === 'apple' && localLlmCapabilities?.apple && (
          <div className="rounded-md border border-border bg-bg-secondary p-3 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium text-text-primary">
                {localLlmCapabilities.apple.available
                  ? 'Apple Intelligence is ready'
                  : 'Apple Intelligence is not available'}
              </span>
              {localLlmCapabilities.apple.backend && (
                <span className="rounded bg-bg-tertiary px-1.5 py-0.5 text-xs font-mono text-text-tertiary">
                  {localLlmCapabilities.apple.backend === 'fm-cli'
                    ? 'fm CLI'
                    : localLlmCapabilities.apple.backend === 'swift-helper-27'
                      ? 'Swift helper (macOS 27)'
                      : 'Swift helper'}
                </span>
              )}
            </div>
            {!localLlmCapabilities.apple.available && localLlmCapabilities.apple.reason && (
              <p className="text-xs text-text-secondary">
                {localLlmCapabilities.apple.reason === 'deviceNotEligible'
                  ? 'This Mac is not eligible for Apple Intelligence.'
                  : localLlmCapabilities.apple.reason === 'appleIntelligenceNotEnabled'
                    ? 'Apple Intelligence is disabled. Enable it in System Settings → Apple Intelligence.'
                    : localLlmCapabilities.apple.reason === 'modelNotReady'
                      ? 'The on-device model is still downloading or preparing. Try again shortly.'
                      : localLlmCapabilities.apple.reason === 'licenseRequired'
                        ? 'fm CLI is installed but its legal notice has not been accepted.'
                        : `Reason: ${localLlmCapabilities.apple.reason}`}
              </p>
            )}
            {localLlmCapabilities.apple.fmCli?.installed &&
              !localLlmCapabilities.apple.fmCli.licenseAccepted && (
                <p className="text-xs text-text-secondary">
                  macOS 27 ships the <code className="font-mono">fm</code> CLI, a faster backend
                  that also supports image prompts. Run{' '}
                  <code className="rounded bg-bg-tertiary px-1 py-0.5 font-mono">
                    sudo fm license
                  </code>{' '}
                  once to enable it.
                </p>
              )}
            <div className="flex flex-wrap gap-1.5">
              {localLlmCapabilities.apple.features.streaming && (
                <span className="rounded bg-bg-tertiary px-1.5 py-0.5 text-xs text-text-secondary">
                  streaming
                </span>
              )}
              {localLlmCapabilities.apple.features.images && (
                <span className="rounded bg-bg-tertiary px-1.5 py-0.5 text-xs text-text-secondary">
                  image prompts
                </span>
              )}
              {localLlmCapabilities.apple.features.tokenCounting && (
                <span className="rounded bg-bg-tertiary px-1.5 py-0.5 text-xs text-text-secondary">
                  token counting
                </span>
              )}
              {localLlmCapabilities.apple.contextSize && (
                <span className="rounded bg-bg-tertiary px-1.5 py-0.5 text-xs text-text-secondary">
                  {localLlmCapabilities.apple.contextSize.toLocaleString()}-token context
                </span>
              )}
              {localLlmCapabilities.apple.osVersion && (
                <span className="rounded bg-bg-tertiary px-1.5 py-0.5 text-xs text-text-tertiary">
                  macOS {localLlmCapabilities.apple.osVersion}
                </span>
              )}
            </div>
          </div>
        )}

        <div className="space-y-3">
          <label className="block text-sm text-text-secondary">Local model servers</label>
          <p className="text-xs text-text-tertiary">
            Endpoint and model are stored per server, so you can point Ollama at a remote host (a
            DGX Spark cluster, a LAN box) while keeping LM Studio local — or vice versa. Leave an
            endpoint empty to use the provider&apos;s localhost default.
          </p>
          <div className="grid gap-3 md:grid-cols-2">
            <Field
              label="Ollama endpoint"
              value={settings.ollamaEndpoint ?? ''}
              onChange={(value) => draft.update('ollamaEndpoint', value)}
              placeholder="http://127.0.0.1:11434/v1"
              saveKey="ollamaEndpoint"
            />
            <Field
              label="Ollama model (optional)"
              value={settings.ollamaModel ?? ''}
              onChange={(value) => draft.update('ollamaModel', value)}
              placeholder="Use the first loaded model"
              saveKey="ollamaModel"
            />
            <Field
              label="LM Studio endpoint"
              value={settings.lmStudioEndpoint ?? ''}
              onChange={(value) => draft.update('lmStudioEndpoint', value)}
              placeholder="http://127.0.0.1:1234/v1"
              saveKey="lmStudioEndpoint"
            />
            <Field
              label="LM Studio model (optional)"
              value={settings.lmStudioModel ?? ''}
              onChange={(value) => draft.update('lmStudioModel', value)}
              placeholder="Use the first loaded model"
              saveKey="lmStudioModel"
            />
          </div>
        </div>
        <p className="text-xs text-text-tertiary">
          Apple Intelligence is offered only on macOS. Ollama and LM Studio work on any supported
          desktop platform. Repository work, tools, code edits, and long-context tasks stay on the
          configured backend.
        </p>
        <TestButton status={localLlmStatus} onClick={testLocalLlm} label="Test Local Model" />
      </SettingsPanel>

      <SettingsPanel
        panelId="thread-assist"
        title="Thread assistance"
        description="Generate a short title and a rolling one-line summary for each thread after a turn completes. Summaries appear under the thread title in the sidebar."
        saveKeys={['threadAssistProvider', 'threadAssistModel']}
        autosave
      >
        <ButtonGrid>
          <ProviderButton
            label="Off"
            description="Keep first-message titles"
            active={assistProvider === 'off'}
            onClick={() => draft.update('threadAssistProvider', 'off')}
          />
          <ProviderButton
            label="Primary provider"
            description="Use the configured agent model"
            active={assistProvider === 'configured'}
            onClick={() => draft.update('threadAssistProvider', 'configured')}
          />
          {localLlmCapabilities?.providers.includes('apple') && (
            <ProviderButton
              label="Apple Intelligence"
              description="On-device, free and private"
              active={assistProvider === 'apple'}
              onClick={() => draft.update('threadAssistProvider', 'apple')}
            />
          )}
          {AGENT_PROVIDER_OPTIONS.filter((option) => enabledProviders.includes(option.id)).map(
            (option) => (
              <ProviderButton
                key={option.id}
                label={option.label}
                description={option.description}
                active={assistProvider === option.id}
                onClick={() => draft.update('threadAssistProvider', option.id)}
              />
            ),
          )}
        </ButtonGrid>
        {assistAgentProvider && (
          <div className="space-y-1">
            <label className="block text-sm text-text-secondary">Thread assistance model</label>
            <select
              value={settings.threadAssistModel ?? ''}
              onChange={(event) => draft.update('threadAssistModel', event.target.value)}
              className="w-full rounded-md border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary outline-none focus:border-accent"
            >
              <option value="">Provider default</option>
              {assistModelOptions.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.label} - {model.id}
                </option>
              ))}
            </select>
            <p className="text-xs text-text-tertiary">
              {assistModelOptions.length
                ? `${assistModelOptions.length} models detected for ${assistAgentProvider}.`
                : 'No model catalog detected — the provider default will be used.'}
            </p>
          </div>
        )}
        {(assistProvider === 'ollama' || assistProvider === 'lm-studio') && (
          <p className="text-xs text-text-tertiary">
            Currently using the legacy {assistProvider === 'ollama' ? 'Ollama' : 'LM Studio'} server
            selection. Pick a provider above to switch.
          </p>
        )}
        <p className="text-xs text-text-tertiary">
          Threads are refreshed periodically as turns complete. Renaming a thread manually locks its
          title so assistance never overwrites it.
        </p>
      </SettingsPanel>
    </>
  );
}
