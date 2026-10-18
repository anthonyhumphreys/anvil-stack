import { useState } from 'react';
import { ArrowDown, ArrowUp, Plus, Search, SlidersHorizontal, Trash2 } from 'lucide-react';
import {
  MAX_MODEL_PICKER_PRESETS,
  type ModelPickerPreferences,
  type ModelPickerPreset,
} from '../../../shared/model-picker';
import type { AgentProvider, ReasoningEffort } from '../../../shared/types';
import type { ChatModelOption } from '../../utils/chat-model-options';
import { createModelPickerPresets, getPresetUnavailableReason } from '../../utils/model-picker';
import { ModelPicker } from '../chat/ModelPicker';
import { ModelPresetSlider } from '../chat/ModelPresetSlider';

const FIELD_CLASS =
  'min-h-10 w-full min-w-0 rounded-lg border border-border bg-bg-primary px-3 text-sm text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent';
const ACTION_CLASS =
  'rounded-md p-1.5 text-text-secondary hover:bg-bg-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-35';

export function ModelPickerPreferencesEditor({
  preferences,
  options,
  provider,
  model,
  onChange,
}: {
  preferences: ModelPickerPreferences;
  options: ChatModelOption[];
  provider: AgentProvider;
  model: string;
  onChange: (preferences: ModelPickerPreferences) => void;
}) {
  const presets = preferences.presets.length
    ? preferences.presets
    : createModelPickerPresets(options, provider, model);
  const [preview, setPreview] = useState<{
    provider: AgentProvider;
    model: string;
    reasoningEffort: ReasoningEffort;
  }>({
    provider,
    model,
    reasoningEffort: 'medium',
  });
  const updatePreset = (id: string, patch: Partial<ModelPickerPreset>) => {
    onChange({
      ...preferences,
      presets: presets.map((preset) => (preset.id === id ? { ...preset, ...patch } : preset)),
    });
  };
  const movePreset = (index: number, direction: -1 | 1) => {
    const reordered = [...presets];
    [reordered[index], reordered[index + direction]] = [
      reordered[index + direction],
      reordered[index],
    ];
    onChange({ ...preferences, presets: reordered });
  };

  return (
    <div className="space-y-5">
      <fieldset>
        <legend className="mb-2 text-sm font-medium text-text-primary">Picker style</legend>
        <div className="grid grid-cols-2 gap-1 rounded-xl border border-border-subtle bg-bg-primary p-1">
          {(
            [
              { style: 'dropdown', label: 'Searchable dropdown', Icon: Search },
              { style: 'slider', label: 'Preset slider', Icon: SlidersHorizontal },
            ] as const
          ).map(({ style, label, Icon }) => (
            <label
              key={style}
              className={`relative flex cursor-pointer items-center justify-center gap-2 rounded-lg px-3 py-3 text-sm transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent ${preferences.style === style ? 'bg-bg-tertiary font-medium text-text-primary' : 'text-text-secondary hover:bg-bg-hover'}`}
            >
              <input
                type="radio"
                name="model-picker-style"
                value={style}
                checked={preferences.style === style}
                onChange={() => onChange({ style, presets })}
                className="sr-only"
              />
              <Icon size={15} className="shrink-0" />
              {label}
            </label>
          ))}
        </div>
        <p className="mt-2 text-xs leading-5 text-text-secondary">
          {preferences.style === 'slider'
            ? 'Move between named presets. Each point can use a different provider, model, and reasoning level.'
            : 'Search by model or provider, with all enabled providers in one list.'}
        </p>
      </fieldset>

      {preferences.style === 'slider' ? (
        <>
          <div className="rounded-xl border border-border-subtle bg-bg-primary">
            <p className="px-4 pt-3 text-xs text-text-secondary">Preview</p>
            <ModelPresetSlider
              presets={presets}
              options={options}
              provider={preview.provider}
              model={preview.model}
              reasoningEffort={preview.reasoningEffort}
              onSelect={(preset) =>
                setPreview({
                  provider: preset.provider,
                  model: preset.model,
                  reasoningEffort: preset.reasoningEffort ?? 'medium',
                })
              }
            />
          </div>
          <div className="flex items-center justify-between gap-3">
            <div>
              <h4 className="text-sm font-medium text-text-primary">Slider points</h4>
              <p className="mt-1 text-xs text-text-secondary">
                Order these to suit the way you work.
              </p>
            </div>
            <span className="text-xs tabular-nums text-text-secondary">
              {presets.length} / {MAX_MODEL_PICKER_PRESETS}
            </span>
          </div>
          <ol className="divide-y divide-border-subtle">
            {presets.map((preset, index) => {
              const selected = options.find(
                (option) => option.provider === preset.provider && option.id === preset.model,
              );
              const unavailable = getPresetUnavailableReason(preset, options);
              return (
                <li key={preset.id} className="py-4 first:pt-0 last:pb-0">
                  <div className="mb-3 flex items-center gap-2">
                    <span className="w-5 shrink-0 text-xs tabular-nums text-text-secondary">
                      {index + 1}
                    </span>
                    <input
                      key={`${preset.id}-${preset.label}`}
                      aria-label={`Point ${index + 1} name`}
                      defaultValue={preset.label}
                      maxLength={32}
                      onBlur={(event) => {
                        const label = event.target.value.trim() || preset.label;
                        event.target.value = label;
                        if (label !== preset.label) updatePreset(preset.id, { label });
                      }}
                      className={`${FIELD_CLASS} flex-1 font-medium`}
                    />
                    <div className="flex shrink-0 items-center">
                      <button
                        type="button"
                        aria-label={`Move ${preset.label} earlier`}
                        disabled={index === 0}
                        onClick={() => movePreset(index, -1)}
                        className={ACTION_CLASS}
                      >
                        <ArrowUp size={14} />
                      </button>
                      <button
                        type="button"
                        aria-label={`Move ${preset.label} later`}
                        disabled={index === presets.length - 1}
                        onClick={() => movePreset(index, 1)}
                        className={ACTION_CLASS}
                      >
                        <ArrowDown size={14} />
                      </button>
                      <button
                        type="button"
                        aria-label={`Remove ${preset.label}`}
                        disabled={presets.length <= 2}
                        onClick={() =>
                          onChange({
                            ...preferences,
                            presets: presets.filter((point) => point.id !== preset.id),
                          })
                        }
                        className={ACTION_CLASS}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                  <div className="grid gap-3 pl-7 sm:grid-cols-[minmax(0,1fr)_10rem]">
                    <div>
                      <span className="mb-1.5 block text-xs text-text-secondary">
                        Provider & model
                      </span>
                      <ModelPicker
                        model={preset.model}
                        provider={preset.provider}
                        options={options}
                        placement="bottom"
                        settingsLink={false}
                        fullWidth
                        onChange={(nextModel, nextProvider) => {
                          const next = options.find(
                            (option) => option.id === nextModel && option.provider === nextProvider,
                          );
                          updatePreset(preset.id, {
                            model: nextModel,
                            provider: nextProvider,
                            reasoningEffort:
                              preset.reasoningEffort &&
                              next?.supportedReasoningEfforts.includes(preset.reasoningEffort)
                                ? preset.reasoningEffort
                                : next?.supportedReasoningEfforts.length
                                  ? next.defaultReasoningEffort
                                  : undefined,
                          });
                        }}
                      />
                    </div>
                    <label className="block">
                      <span className="mb-1.5 block text-xs text-text-secondary">Reasoning</span>
                      <select
                        value={preset.reasoningEffort ?? ''}
                        disabled={!selected?.supportedReasoningEfforts.length}
                        onChange={(event) =>
                          updatePreset(preset.id, {
                            reasoningEffort: event.target.value
                              ? (event.target.value as ModelPickerPreset['reasoningEffort'])
                              : undefined,
                          })
                        }
                        className={`${FIELD_CLASS} disabled:text-text-secondary`}
                      >
                        <option value="">
                          {selected?.supportedReasoningEfforts.length
                            ? 'Model default'
                            : 'Set by model'}
                        </option>
                        {preset.reasoningEffort &&
                          !selected?.supportedReasoningEfforts.includes(preset.reasoningEffort) && (
                            <option value={preset.reasoningEffort}>
                              {preset.reasoningEffort} · unavailable
                            </option>
                          )}
                        {selected?.supportedReasoningEfforts.map((effort) => (
                          <option key={effort} value={effort}>
                            {effort === 'xhigh'
                              ? 'Extra high'
                              : effort.charAt(0).toUpperCase() + effort.slice(1)}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  {unavailable && <p className="mt-2 pl-7 text-xs text-warning">{unavailable}</p>}
                </li>
              );
            })}
          </ol>
          <button
            type="button"
            disabled={presets.length >= MAX_MODEL_PICKER_PRESETS || !options.length}
            onClick={() => {
              const base =
                presets[presets.length - 1] ??
                createModelPickerPresets(options, provider, model)[0];
              if (base)
                onChange({
                  ...preferences,
                  presets: [
                    ...presets,
                    { ...base, id: crypto.randomUUID(), label: `Preset ${presets.length + 1}` },
                  ],
                });
            }}
            className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-xs font-medium text-text-secondary hover:bg-bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-40"
          >
            <Plus size={14} /> Add slider point
          </button>
        </>
      ) : (
        <div className="max-w-sm">
          <p className="mb-2 text-xs text-text-secondary">Try the picker</p>
          <ModelPicker
            model={preview.model}
            provider={preview.provider}
            options={options}
            settingsLink={false}
            placement="bottom"
            fullWidth
            onChange={(nextModel, nextProvider) =>
              setPreview({ ...preview, model: nextModel, provider: nextProvider })
            }
          />
        </div>
      )}
    </div>
  );
}
