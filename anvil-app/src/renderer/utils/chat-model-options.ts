import { CODEX_MODEL_OPTIONS, CODEX_REASONING_EFFORTS } from '../../shared/codex-models';
import type {
  AgentProvider,
  CodexCliStatus,
  CursorCliStatus,
  ReasoningEffort,
} from '../../shared/types';

export interface ChatModelOption {
  id: string;
  label: string;
  description: string;
  supportedReasoningEfforts: ReasoningEffort[];
  defaultReasoningEffort: ReasoningEffort;
}

export function buildChatModelOptions(
  provider: AgentProvider,
  selectedModel: string,
  codexStatus: CodexCliStatus | null,
  cursorStatus: CursorCliStatus | null,
): ChatModelOption[] {
  const detectedCodexOptions = codexStatus?.models
    ?.filter((model) => !model.hidden)
    .map((model) => ({
      id: model.id,
      label: model.displayName ?? model.id,
      description: model.description ?? 'Detected from the local Codex CLI model catalog.',
      supportedReasoningEfforts: model.supportedReasoningEfforts,
      defaultReasoningEffort: model.defaultReasoningEffort ?? 'medium',
    }));
  const options =
    provider === 'cursor'
      ? (cursorStatus?.models ?? []).map((model) => ({
          id: model.id,
          label: model.label,
          description: 'Detected from the local Cursor CLI model catalog.',
          supportedReasoningEfforts: [],
          defaultReasoningEffort: 'medium' as ReasoningEffort,
        }))
      : detectedCodexOptions?.length
        ? detectedCodexOptions
        : CODEX_MODEL_OPTIONS.map((model) => ({
            id: model.id,
            label: model.label,
            description: model.description,
            supportedReasoningEfforts: model.supportedReasoningEfforts,
            defaultReasoningEffort: model.defaultReasoningEffort,
          }));

  if (options.some((option) => option.id === selectedModel)) return options;
  return [
    {
      id: selectedModel,
      label: selectedModel,
      description:
        provider === 'cursor'
          ? 'Custom Cursor model selected in Settings.'
          : 'Custom model or deployment selected in Settings.',
      supportedReasoningEfforts: provider === 'cursor' ? [] : CODEX_REASONING_EFFORTS,
      defaultReasoningEffort: 'medium',
    },
    ...options,
  ];
}
