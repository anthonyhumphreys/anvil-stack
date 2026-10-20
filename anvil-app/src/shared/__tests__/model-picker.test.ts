import { describe, expect, it } from 'vitest';
import { normaliseModelPickerPreferences } from '../model-picker';

describe('model picker settings', () => {
  it('defaults old installations and damaged JSON to the searchable dropdown', () => {
    for (const input of [undefined, null, '{broken', 1]) {
      expect(normaliseModelPickerPreferences(input)).toEqual({ style: 'dropdown', presets: [] });
    }
  });

  it('preserves cross-provider presets and opaque model IDs through JSON', () => {
    const settings = {
      style: 'slider',
      presets: [
        { id: 'fast', label: 'Quick', provider: 'cursor', model: 'vendor/model:fast' },
        {
          id: 'deep',
          label: 'Deep work',
          provider: 'llmgateway',
          model: 'vendor/model',
          reasoningEffort: 'high',
        },
      ],
    };
    expect(normaliseModelPickerPreferences(JSON.stringify(settings))).toEqual(settings);
  });

  it('rejects malformed presets, deduplicates IDs, and bounds settings size', () => {
    const preset = { id: '1', label: ' Everyday ', provider: 'codex', model: 'model' };
    const result = normaliseModelPickerPreferences({
      style: 'unknown',
      presets: [
        null,
        {},
        { ...preset, provider: 'unknown' },
        preset,
        preset,
        ...Array.from({ length: 10 }, (_, i) => ({ ...preset, id: `extra-${i}` })),
      ],
    });
    expect(result.style).toBe('dropdown');
    expect(result.presets).toHaveLength(7);
    expect(result.presets[0].label).toBe('Everyday');
  });
});
