import { describe, expect, it } from 'vitest';
import type { ChatModelOption } from '../chat-model-options';
import type { ModelPickerPreset } from '../../../shared/model-picker';
import {
  createModelPickerPresets,
  filterModelOptions,
  findActiveModelPreset,
  getPresetUnavailableReason,
  modelSelectionKey,
} from '../model-picker';

const codex: ChatModelOption = {
  provider: 'codex',
  id: 'shared-model',
  label: 'Sol',
  description: 'Coding model',
  supportedReasoningEfforts: ['low', 'medium', 'high'],
  defaultReasoningEffort: 'medium',
  serviceTiers: [],
};
const cursor: ChatModelOption = {
  ...codex,
  provider: 'cursor',
  label: 'Cursor Sol',
  supportedReasoningEfforts: [],
};
const options = [codex, cursor];
const preset: ModelPickerPreset = {
  id: 'deep',
  label: 'Deep work',
  provider: 'codex',
  model: codex.id,
  reasoningEffort: 'high',
};

describe('model picker choices', () => {
  it('searches across provider, model ID, label, and description with multiple terms', () => {
    expect(filterModelOptions(options, 'CURSOR shared')).toEqual([cursor]);
    expect(filterModelOptions(options, 'sol coding')).toEqual(options);
    expect(filterModelOptions(options, 'missing')).toEqual([]);
    expect(modelSelectionKey('codex', 'same')).not.toBe(modelSelectionKey('cursor', 'same'));
  });

  it('only suggests reasoning levels that the model advertises', () => {
    expect(
      createModelPickerPresets(options, 'codex', codex.id).map((item) => item.reasoningEffort),
    ).toEqual(['low', 'medium', 'high']);
    expect(createModelPickerPresets([cursor], 'cursor', cursor.id)).toEqual([
      { id: 'preset-1', label: 'Cursor Sol', provider: 'cursor', model: cursor.id },
    ]);
    expect(createModelPickerPresets([], 'llmgateway', '')).toEqual([]);
  });

  it('matches model, provider, and effort without snapping custom selections to a preset', () => {
    expect(findActiveModelPreset([preset], 'codex', codex.id, 'high', options)).toBe(0);
    expect(findActiveModelPreset([preset], 'cursor', codex.id, 'high', options)).toBe(-1);
    expect(findActiveModelPreset([preset], 'codex', codex.id, 'low', options)).toBe(-1);
    const defaultPreset = { ...preset, reasoningEffort: undefined };
    expect(findActiveModelPreset([defaultPreset], 'codex', codex.id, 'high', options)).toBe(-1);
    expect(findActiveModelPreset([defaultPreset], 'codex', codex.id, 'medium', options)).toBe(0);
  });

  it('explains disabled providers, missing models, and changed reasoning capabilities', () => {
    expect(getPresetUnavailableReason(preset, options)).toBeUndefined();
    expect(getPresetUnavailableReason(preset, [cursor])).toContain('Enable this provider');
    expect(getPresetUnavailableReason({ ...preset, model: 'removed' }, options)).toContain(
      'Model unavailable',
    );
    expect(getPresetUnavailableReason({ ...preset, provider: 'cursor' }, options)).toContain(
      'Reasoning level unavailable',
    );
  });
});
