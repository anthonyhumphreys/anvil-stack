import { CODEX_MODEL_OPTIONS, CODEX_REASONING_EFFORTS } from '../../shared/codex-models';
import type {
  AgentProvider,
  CodexCliStatus,
  CursorCliStatus,
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
): ChatModelOption[] {
  const detectedCodexOptions = codexStatus?.models
    ?.filter((model) => !model.hidden)
    .map((model) => ({
      provider,
      id: model.id,
      label: model.displayName ?? model.id,
      description: model.description ?? 'Detected from the local Codex CLI model catalog.',
      supportedReasoningEfforts: model.supportedReasoningEfforts,
      defaultReasoningEffort: model.defaultReasoningEffort ?? 'medium',
      serviceTiers: model.serviceTiers,
    }));
  const options =
    provider === 'cursor'
      ? (cursorStatus?.models ?? []).map((model) => ({
          provider,
          id: model.id,
          label: model.label,
          description: 'Detected from the local Cursor CLI model catalog.',
          supportedReasoningEfforts: [],
          defaultReasoningEffort: 'medium' as ReasoningEffort,
          serviceTiers: [],
        }))
      : detectedCodexOptions?.length
        ? detectedCodexOptions
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
      description:
        provider === 'cursor'
          ? 'Custom Cursor model selected in Settings.'
          : 'Custom model or deployment selected in Settings.',
      supportedReasoningEfforts: provider === 'cursor' ? [] : CODEX_REASONING_EFFORTS,
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
): ChatModelOption[] {
  return [...new Set([selectedProvider, ...enabledProviders])].flatMap((provider) =>
    buildProviderModelOptions(
      provider,
      provider === selectedProvider ? selectedModel : null,
      codexStatus,
      cursorStatus,
    ),
  );
}
