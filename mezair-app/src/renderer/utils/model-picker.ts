import type { ModelPickerPreset } from '../../shared/model-picker';
import type { AgentProvider, ReasoningEffort } from '../../shared/types';
import type { ChatModelOption } from './chat-model-options';

export const MODEL_PROVIDER_LABELS: Record<AgentProvider, string> = {
  codex: 'Codex CLI',
  openai: 'OpenAI',
  azure: 'Azure Foundry',
  cursor: 'Cursor CLI',
  devin: 'Devin CLI',
  llmgateway: 'LLMGateway',
};

export function modelSelectionKey(provider: AgentProvider, model: string): string {
  return JSON.stringify([provider, model]);
}

export function filterModelOptions(options: ChatModelOption[], query: string): ChatModelOption[] {
  const terms = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  return options.filter((option) => {
    const text = [
      option.label,
      option.id,
      MODEL_PROVIDER_LABELS[option.provider],
      option.description,
    ]
      .join(' ')
      .toLocaleLowerCase();
    return terms.every((term) => text.includes(term));
  });
}

export function createModelPickerPresets(
  options: ChatModelOption[],
  provider: AgentProvider,
  model: string,
): ModelPickerPreset[] {
  const selected =
    options.find((option) => option.provider === provider && option.id === model) ??
    options.find((option) => option.provider === provider) ??
    options[0];
  if (!selected) return [];
  const efforts = selected.supportedReasoningEfforts;
  if (efforts.length > 1) {
    return [
      { id: 'quick', label: 'Quick', effort: efforts[0] },
      { id: 'everyday', label: 'Everyday', effort: selected.defaultReasoningEffort },
      { id: 'deep', label: 'Deep work', effort: efforts[efforts.length - 1] },
    ].map(({ id, label, effort }) => ({
      id,
      label,
      provider: selected.provider,
      model: selected.id,
      reasoningEffort: efforts.includes(effort) ? effort : efforts[0],
    }));
  }
  // Catalog order implies no quality ranking. Name these choices after the models.
  const choices = [selected, ...options.filter((option) => option !== selected)].slice(0, 3);
  return choices.map((option, index) => ({
    id: `preset-${index + 1}`,
    label: option.label.slice(0, 32),
    provider: option.provider,
    model: option.id,
  }));
}

export function getPresetUnavailableReason(
  preset: ModelPickerPreset,
  options: ChatModelOption[],
): string | undefined {
  if (!options.some((option) => option.provider === preset.provider)) {
    return 'Enable this provider in AI connections.';
  }
  const option = options.find(
    (option) => option.provider === preset.provider && option.id === preset.model,
  );
  if (!option) return 'Model unavailable. Choose another model in Settings.';
  if (
    preset.reasoningEffort &&
    !option.supportedReasoningEfforts.includes(preset.reasoningEffort)
  ) {
    return 'Reasoning level unavailable. Update this preset in Settings.';
  }
  return undefined;
}

export function findActiveModelPreset(
  presets: ModelPickerPreset[],
  provider: AgentProvider,
  model: string,
  reasoningEffort: ReasoningEffort,
  options: ChatModelOption[] = [],
): number {
  return presets.findIndex((preset) => {
    const option = options.find(
      (item) => item.provider === preset.provider && item.id === preset.model,
    );
    const effort =
      preset.reasoningEffort ??
      (option?.supportedReasoningEfforts.length ? option.defaultReasoningEffort : undefined);
    return (
      preset.provider === provider &&
      preset.model === model &&
      (!effort || effort === reasoningEffort)
    );
  });
}
