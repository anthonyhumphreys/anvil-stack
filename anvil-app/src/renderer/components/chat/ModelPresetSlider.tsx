import { useState } from 'react';
import type { ModelPickerPreset } from '../../../shared/model-picker';
import type { AgentProvider, ReasoningEffort } from '../../../shared/types';
import type { ChatModelOption } from '../../utils/chat-model-options';
import {
  findActiveModelPreset,
  getPresetUnavailableReason,
  MODEL_PROVIDER_LABELS,
} from '../../utils/model-picker';

export function ModelPresetSlider({
  presets,
  options,
  provider,
  model,
  reasoningEffort,
  onSelect,
}: {
  presets: ModelPickerPreset[];
  options: ChatModelOption[];
  provider: AgentProvider;
  model: string;
  reasoningEffort: ReasoningEffort;
  onSelect: (preset: ModelPickerPreset) => void;
}) {
  const active = findActiveModelPreset(presets, provider, model, reasoningEffort, options);
  const [preview, setPreview] = useState<number | null>(null);
  const index = Math.min(preview ?? Math.max(active, 0), presets.length - 1);
  const preset = presets[index];
  if (!preset)
    return (
      <p className="p-4 text-sm text-text-secondary">
        Add slider presets in Settings to get started.
      </p>
    );
  const unavailable = getPresetUnavailableReason(preset, options);
  const option = options.find(
    (item) => item.provider === preset.provider && item.id === preset.model,
  );
  const select = (next: number) => {
    const choice = presets[next];
    setPreview(next);
    if (choice && !getPresetUnavailableReason(choice, options)) onSelect(choice);
  };

  return (
    <div className="space-y-4 p-4">
      <div>
        <div className="flex items-center justify-between gap-3">
          <span className="truncate text-sm font-semibold text-text-primary">{preset.label}</span>
          <span className="shrink-0 text-xs text-text-secondary">
            {active === index && !unavailable ? 'Selected' : 'Preset'}
          </span>
        </div>
        <p className="mt-1 truncate text-xs text-text-secondary" title={preset.model}>
          {MODEL_PROVIDER_LABELS[preset.provider]} · {option?.label ?? preset.model}
          {preset.reasoningEffort ? ` · ${preset.reasoningEffort}` : ''}
        </p>
      </div>
      <div>
        <input
          type="range"
          min={0}
          max={Math.max(presets.length - 1, 1)}
          step={1}
          value={Math.max(index, 0)}
          disabled={presets.length < 2}
          aria-label="Model preset"
          aria-valuetext={`${preset.label}, ${MODEL_PROVIDER_LABELS[preset.provider]}, ${option?.label ?? preset.model}${preset.reasoningEffort ? `, ${preset.reasoningEffort} reasoning` : ''}${unavailable ? ', unavailable' : ''}`}
          onChange={(event) => setPreview(Number(event.target.value))}
          onPointerUp={(event) => select(Number(event.currentTarget.value))}
          onKeyUp={(event) => {
            if (
              [
                'ArrowLeft',
                'ArrowRight',
                'ArrowUp',
                'ArrowDown',
                'Home',
                'End',
                'PageUp',
                'PageDown',
              ].includes(event.key)
            )
              select(Number(event.currentTarget.value));
          }}
          className="model-preset-range w-full"
          style={{
            marginLeft: `${50 / presets.length}%`,
            width: `${(100 * (presets.length - 1)) / presets.length}%`,
          }}
        />
        <div className="mt-1 flex justify-between gap-1">
          {presets.map((point, pointIndex) => (
            <button
              key={point.id}
              type="button"
              onClick={() => select(pointIndex)}
              aria-pressed={active === pointIndex}
              aria-disabled={!!getPresetUnavailableReason(point, options)}
              title={getPresetUnavailableReason(point, options) ?? point.label}
              className={`min-w-0 flex-1 truncate rounded-md px-1 py-1.5 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${index === pointIndex ? 'font-medium text-accent' : 'text-text-secondary hover:bg-bg-hover'}`}
            >
              {point.label}
            </button>
          ))}
        </div>
      </div>
      <p
        className={`text-xs leading-5 ${unavailable ? 'text-warning' : 'text-text-secondary'}`}
        role="status"
      >
        {unavailable ??
          (active < 0
            ? 'Your current selection is outside these presets. Choose a point to switch.'
            : 'Each point uses the provider, model, and reasoning you choose in Settings.')}
      </p>
    </div>
  );
}
