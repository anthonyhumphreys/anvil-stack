import { CODEX_MODEL_OPTIONS, CODEX_REASONING_EFFORTS } from '../../shared/codex-models';
import { isAcpAgentProvider } from '../../shared/agent-providers';
import type {
  AgentProvider,
  CodexCliStatus,
  CursorCliStatus,
  DevinCliStatus,
  LlmGatewayStatus,
  ReasoningEffort,
} from '../../shared/types';

export interface ChatModelOption {
  provider: AgentProvider;
  id: string;
  label: string;
  description: string;
  supportedReasoningEfforts: ReasoningEffort[];
  defaultReasoningEffort: ReasoningEffort;
  serviceTiers: Array<{ id: string; name: string; description?: string }>;
}

export function buildProviderModelOptions(
  provider: AgentProvider,
  selectedModel: string | null,
  codexStatus: CodexCliStatus | null,
  cursorStatus: CursorCliStatus | null,
  llmGatewayStatus?: LlmGatewayStatus | null,
  devinStatus?: DevinCliStatus | null,
): ChatModelOption[] {
  const catalogModels = provider === 'llmgateway' ? llmGatewayStatus?.models : codexStatus?.models;
  const detectedCodexOptions = catalogModels
    ?.filter((model) => !model.hidden)
    .map((model) => ({
      provider,
      id: model.id,
      label: model.displayName ?? model.id,
      description:
        model.description ??
        (provider === 'llmgateway'
          ? 'Available through the LLMGateway model catalog.'
          : 'Detected from the local Codex CLI model catalog.'),
      supportedReasoningEfforts: model.supportedReasoningEfforts,
      defaultReasoningEffort: model.defaultReasoningEffort ?? 'medium',
      serviceTiers: model.serviceTiers,
    }));
  const acpModels =
    provider === 'cursor'
      ? cursorStatus?.models
      : provider === 'devin'
        ? devinStatus?.models
        : undefined;
  const options =
    provider === 'cursor' || provider === 'devin'
      ? acpModels?.length
        ? [
            {
              provider,
              id: 'auto',
              label:
                provider === 'devin'
                  ? `Auto (${devinStatus?.defaultModel ?? 'Devin'} default)`
                  : 'Auto (Cursor default)',
              description:
                provider === 'devin'
                  ? 'Let Devin pick the model for each session.'
                  : "Use Cursor's default model selection.",
              supportedReasoningEfforts: [],
              defaultReasoningEffort: 'medium' as ReasoningEffort,
              serviceTiers: [],
            },
            ...acpModels.map((model) => ({
              provider,
              id: model.id,
              label: model.label,
              description: `Detected from the local ${provider === 'devin' ? 'Devin' : 'Cursor'} CLI model catalog.`,
              supportedReasoningEfforts: [],
              defaultReasoningEffort: 'medium' as ReasoningEffort,
              serviceTiers: [],
            })),
          ]
        : [
            {
              provider,
              id: 'auto',
              label: `Auto (${provider === 'devin' ? 'Devin' : 'Cursor'} default)`,
              description:
                provider === 'devin'
                  ? 'Devin model catalog unavailable. Use the Devin default model, or sign in to list specific models.'
                  : "Cursor model catalog unavailable. Use Cursor's default model, or sign in to list specific models.",
              supportedReasoningEfforts: [],
              defaultReasoningEffort: 'medium' as ReasoningEffort,
              serviceTiers: [],
            },
          ]
      : detectedCodexOptions?.length
        ? detectedCodexOptions
        : provider === 'llmgateway'
          ? []
          : CODEX_MODEL_OPTIONS.map((model) => ({
              provider,
              id: model.id,
              label: model.label,
              description: model.description,
              supportedReasoningEfforts: model.supportedReasoningEfforts,
              defaultReasoningEffort: model.defaultReasoningEffort,
              serviceTiers: [],
            }));

  if (!selectedModel || options.some((option) => option.id === selectedModel)) return options;
  return [
    {
      provider,
      id: selectedModel,
      label: selectedModel,
      // Plain-text descriptions (rendered inside option labels, no links) —
      // name the owning panel: Settings → Providers & models.
      description: isAcpAgentProvider(provider)
        ? `Custom ${provider === 'devin' ? 'Devin' : 'Cursor'} model selected under Settings → Providers & models.`
        : provider === 'llmgateway'
          ? 'Selected model is unavailable in the LLMGateway catalog. Refresh models under Settings → Providers & models.'
          : 'Custom model or deployment selected under Settings → Providers & models.',
      supportedReasoningEfforts:
        isAcpAgentProvider(provider) || provider === 'llmgateway' ? [] : CODEX_REASONING_EFFORTS,
      defaultReasoningEffort: 'medium',
      serviceTiers: [],
    },
    ...options,
  ];
}

export function buildChatModelOptions(
  enabledProviders: AgentProvider[],
  selectedProvider: AgentProvider,
  selectedModel: string,
  codexStatus: CodexCliStatus | null,
  cursorStatus: CursorCliStatus | null,
  llmGatewayStatus?: LlmGatewayStatus | null,
  devinStatus?: DevinCliStatus | null,
): ChatModelOption[] {
  return [...new Set([selectedProvider, ...enabledProviders])].flatMap((provider) =>
    buildProviderModelOptions(
      provider,
      provider === selectedProvider ? selectedModel : null,
      codexStatus,
      cursorStatus,
      llmGatewayStatus,
      devinStatus,
    ),
  );
}
