import { Check, ChevronDown, Loader2, Square, type LucideIcon } from 'lucide-react';
import { Menu, MenuItem, MenuLabel, cx } from '../ui';

export interface ComposerSendOption<Id extends string = string> {
  id: Id;
  /** Menu label, e.g. "Queue next". */
  label: string;
  /** Primary button label, e.g. "Queue". */
  shortLabel: string;
  description: string;
  icon: LucideIcon;
  disabled: boolean;
  pending: boolean;
  /** Accessible name for the primary button when this option is selected. */
  ariaLabel: string;
  run: () => void;
}

/**
 * One primary send action plus, when there are alternatives, a menu of the
 * other ways to send. Choosing a mode never submits the draft.
 */
export function ComposerSendControl<Id extends string>({
  options,
  selectedId,
  onSelect,
  hasContent,
  menuLabel,
}: {
  options: ComposerSendOption<Id>[];
  selectedId: Id;
  onSelect: (id: Id) => void;
  hasContent: boolean;
  menuLabel: string;
}) {
  const selected = options.find((option) => option.id === selectedId) ?? options[0];
  if (!selected) return null;
  const Icon = selected.icon;
  const pending = options.some((option) => option.pending);

  return (
    <div
      className={`composer-send-control flex h-8 items-stretch overflow-hidden rounded-lg bg-accent text-accent-foreground ${hasContent ? '' : 'opacity-50'}`}
    >
      <button
        type="button"
        onClick={selected.run}
        disabled={selected.disabled}
        className="composer-send flex items-center justify-center gap-1.5 px-2.5 text-xs font-semibold transition-[filter,opacity] duration-150 hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-foreground/70 disabled:cursor-not-allowed disabled:opacity-50"
        aria-label={selected.pending ? `${selected.label}: sending` : selected.ariaLabel}
        aria-busy={selected.pending}
        title={selected.description}
      >
        {selected.pending ? (
          <Loader2 size={13} className="animate-spin motion-reduce:animate-none" />
        ) : (
          <Icon size={13} />
        )}
        {selected.pending ? 'Sending…' : selected.shortLabel}
      </button>
      {options.length > 1 && (
        <Menu
          label={menuLabel}
          side="top"
          align="end"
          menuClassName="w-72"
          trigger={(props) => (
            <button
              {...props}
              type="button"
              disabled={pending}
              className="flex w-7 items-center justify-center border-l border-accent-foreground/20 transition-[filter] duration-150 hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-foreground/70 disabled:opacity-50"
              aria-label={menuLabel}
              title={menuLabel}
            >
              <ChevronDown size={13} />
            </button>
          )}
        >
          <MenuLabel>Choose how to send</MenuLabel>
          {options.map((option) => {
            const OptionIcon = option.icon;
            const active = option.id === selected.id;
            return (
              <MenuItem
                key={option.id}
                disabled={pending}
                onSelect={() => onSelect(option.id)}
                className="items-start"
                icon={<OptionIcon size={14} className="mt-0.5 shrink-0" aria-hidden="true" />}
              >
                <span className="min-w-0 flex-1 text-left">
                  <span className="block font-medium text-text-primary">{option.label}</span>
                  <span className="block text-xs leading-snug text-text-tertiary">
                    {option.description}
                  </span>
                </span>
                <Check
                  size={13}
                  aria-hidden="true"
                  className={cx(
                    'mt-0.5 shrink-0 text-accent',
                    active ? 'opacity-100' : 'opacity-0',
                  )}
                />
                {active && <span className="sr-only">(default)</span>}
              </MenuItem>
            );
          })}
        </Menu>
      )}
    </div>
  );
}

/** Stops the current run. Clear and reachable, without shouting over the draft. */
export function ComposerStopButton({ onStop }: { onStop?: () => void }) {
  return (
    <button
      type="button"
      onClick={onStop}
      disabled={!onStop}
      className="flex h-8 items-center justify-center gap-1.5 rounded-lg border border-border px-2.5 text-xs font-medium text-text-secondary transition-colors duration-150 hover:bg-bg-tertiary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70 disabled:cursor-not-allowed disabled:opacity-50"
      title="Stop the current run"
      aria-label="Stop current run"
    >
      <Square size={11} fill="currentColor" aria-hidden="true" />
      Stop
    </button>
  );
}
