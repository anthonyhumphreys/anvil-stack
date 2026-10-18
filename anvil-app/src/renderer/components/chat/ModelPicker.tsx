import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Search, Settings2, SlidersHorizontal } from 'lucide-react';
import { Link } from 'react-router-dom';
import {
  DEFAULT_MODEL_PICKER_PREFERENCES,
  type ModelPickerPreferences,
} from '../../../shared/model-picker';
import type { AgentProvider, ReasoningEffort } from '../../../shared/types';
import type { ChatModelOption } from '../../utils/chat-model-options';
import {
  createModelPickerPresets,
  findActiveModelPreset,
  MODEL_PROVIDER_LABELS,
} from '../../utils/model-picker';
import { ModelSearchList } from './ModelSearchList';
import { ModelPresetSlider } from './ModelPresetSlider';

export function ModelPicker({
  model,
  provider,
  options,
  preferences = DEFAULT_MODEL_PICKER_PREFERENCES,
  reasoningEffort = 'medium',
  onChange,
  placement = 'top',
  settingsLink = true,
  fullWidth = false,
}: {
  model: string;
  provider: AgentProvider;
  options: ChatModelOption[];
  preferences?: ModelPickerPreferences;
  reasoningEffort?: ReasoningEffort;
  onChange: (model: string, provider: AgentProvider, reasoningEffort?: ReasoningEffort) => void;
  placement?: 'top' | 'bottom';
  settingsLink?: boolean;
  fullWidth?: boolean;
}) {
  const id = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [browse, setBrowse] = useState(false);
  const [position, setPosition] = useState<CSSProperties>({});
  const selected = options.find((option) => option.provider === provider && option.id === model);
  const presets = preferences.presets.length
    ? preferences.presets
    : createModelPickerPresets(options, provider, model);
  const active = findActiveModelPreset(presets, provider, model, reasoningEffort, options);
  const slider = preferences.style === 'slider' && !browse;

  const close = (restoreFocus = true) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  };

  useLayoutEffect(() => {
    if (!open) return;
    const reposition = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(376, window.innerWidth - 24);
      const above = rect.top - 20;
      const below = window.innerHeight - rect.bottom - 20;
      const top =
        placement === 'top' ? above >= 260 || above > below : below < 260 && above > below;
      setPosition({
        width,
        left: Math.max(
          12,
          Math.min(fullWidth ? rect.left : rect.right - width, window.innerWidth - width - 12),
        ),
        ...(top ? { bottom: window.innerHeight - rect.top + 8 } : { top: rect.bottom + 8 }),
        maxHeight: Math.max(120, top ? above : below),
      });
    };
    reposition();
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [open, fullWidth, placement]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (
        !panelRef.current?.contains(event.target as Node) &&
        !triggerRef.current?.contains(event.target as Node)
      )
        setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    if (slider) panelRef.current?.querySelector<HTMLInputElement>('input[type="range"]')?.focus();
    return () => document.removeEventListener('pointerdown', outside);
  }, [open, slider]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label={`Choose model: ${MODEL_PROVIDER_LABELS[provider]}, ${selected?.label ?? model}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={open ? id : undefined}
        title={`${MODEL_PROVIDER_LABELS[provider]} · ${selected?.label ?? model}`}
        onClick={() => {
          setBrowse(false);
          setOpen(!open);
        }}
        className={`flex min-w-0 items-center gap-2 rounded-lg border border-border-subtle bg-bg-secondary px-2.5 text-left text-xs text-text-primary transition-colors hover:border-border hover:bg-bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${fullWidth ? 'min-h-10 w-full' : 'h-8 max-w-64'}`}
      >
        {preferences.style === 'slider' ? (
          <SlidersHorizontal size={13} className="shrink-0 text-text-secondary" />
        ) : null}
        <span className="shrink-0 text-text-secondary">
          {MODEL_PROVIDER_LABELS[provider].replace(' CLI', '')}
        </span>
        <span aria-hidden="true" className="text-text-secondary">
          ·
        </span>
        <span className="min-w-0 flex-1 truncate">
          {preferences.style === 'slider' && active >= 0 ? `${presets[active].label} · ` : ''}
          {selected?.label ?? (model || 'Choose model')}
        </span>
        <ChevronDown size={12} className="shrink-0 text-text-secondary" />
      </button>
      {open &&
        createPortal(
          <div
            ref={panelRef}
            id={id}
            role="dialog"
            aria-label="Choose model"
            style={position}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                close();
              }
            }}
            onBlur={(event) => {
              if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget))
                setOpen(false);
            }}
            className="fixed z-[100] flex flex-col overflow-hidden rounded-xl border border-border bg-bg-elevated text-text-primary shadow-lg"
          >
            {slider ? (
              <>
                <div className="flex items-center justify-between border-b border-border-subtle px-4 py-3">
                  <span className="text-sm font-medium">Model presets</span>
                  <button
                    type="button"
                    onClick={() => setBrowse(true)}
                    className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-text-secondary hover:bg-bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  >
                    <Search size={13} /> All models
                  </button>
                </div>
                <div className="min-h-0 overflow-y-auto">
                  <ModelPresetSlider
                    presets={presets}
                    options={options}
                    provider={provider}
                    model={model}
                    reasoningEffort={reasoningEffort}
                    onSelect={(preset) => {
                      const option = options.find(
                        (item) => item.provider === preset.provider && item.id === preset.model,
                      );
                      onChange(
                        preset.model,
                        preset.provider,
                        preset.reasoningEffort ?? option?.defaultReasoningEffort,
                      );
                    }}
                  />
                </div>
              </>
            ) : (
              <ModelSearchList
                options={options}
                provider={provider}
                model={model}
                onSelect={(option) => {
                  onChange(option.id, option.provider);
                  close();
                }}
              />
            )}
            {settingsLink && (
              <Link
                to="/settings/providers#model-picker"
                onClick={() => close(false)}
                className="flex shrink-0 items-center gap-2 border-t border-border-subtle px-4 py-2.5 text-xs text-text-secondary hover:bg-bg-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
              >
                <Settings2 size={13} /> Configure model picker
              </Link>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
