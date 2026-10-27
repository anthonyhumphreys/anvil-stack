import { isAgentProvider } from './agent-providers.js';
import { CODEX_REASONING_EFFORTS } from './codex-models.js';
import type { AgentProvider, ReasoningEffort } from './types.js';

export interface ModelPickerPreset {
  id: string;
  label: string;
  provider: AgentProvider;
  model: string;
  /** Omitted when reasoning is controlled by the model or provider. */
  reasoningEffort?: ReasoningEffort;
}

export interface ModelPickerPreferences {
  style: 'dropdown' | 'slider';
  presets: ModelPickerPreset[];
}

export const MAX_MODEL_PICKER_PRESETS = 7;
export const DEFAULT_MODEL_PICKER_PREFERENCES: ModelPickerPreferences = {
  style: 'dropdown',
  presets: [],
};

/** Settings cross both an IPC and a JSON persistence boundary. */
export function normaliseModelPickerPreferences(value: unknown): ModelPickerPreferences {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return { ...DEFAULT_MODEL_PICKER_PREFERENCES };
    }
  }
  if (!value || typeof value !== 'object') return { ...DEFAULT_MODEL_PICKER_PREFERENCES };
  const input = value as Record<string, unknown>;
  const ids = new Set<string>();
  const presets: ModelPickerPreset[] = [];
  for (const item of Array.isArray(input.presets) ? input.presets : []) {
    if (!item || typeof item !== 'object') continue;
    const preset = item as Record<string, unknown>;
    if (
      typeof preset.id !== 'string' ||
      !preset.id.trim() ||
      ids.has(preset.id) ||
      typeof preset.label !== 'string' ||
      !preset.label.trim() ||
      !isAgentProvider(preset.provider) ||
      typeof preset.model !== 'string' ||
      !preset.model.trim()
    )
      continue;
    ids.add(preset.id);
    presets.push({
      id: preset.id,
      label: preset.label.trim().slice(0, 32),
      provider: preset.provider,
      model: preset.model.trim(),
      ...(CODEX_REASONING_EFFORTS.includes(preset.reasoningEffort as ReasoningEffort)
        ? { reasoningEffort: preset.reasoningEffort as ReasoningEffort }
        : {}),
    });
    if (presets.length === MAX_MODEL_PICKER_PRESETS) break;
  }
  return { style: input.style === 'slider' ? 'slider' : 'dropdown', presets };
}
