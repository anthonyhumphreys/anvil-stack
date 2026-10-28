import { ArrowUp, Check, ChevronDown, Loader2, Square, type LucideIcon } from 'lucide-react';
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
  const iconOnlySend = selected.id === 'send';

  return (
    <div className="composer-send-control flex shrink-0 items-center gap-1">
      <button
        type="button"
        onClick={selected.run}
        disabled={selected.disabled}
        className={`composer-send flex h-10 items-center justify-center gap-1.5 transition-[background-color,color,opacity] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/55 disabled:cursor-not-allowed ${
          iconOnlySend
            ? 'w-10 rounded-full bg-accent text-accent-foreground hover:brightness-110 disabled:bg-bg-tertiary disabled:text-text-tertiary'
            : 'rounded-full bg-accent px-3 text-xs font-semibold text-accent-foreground hover:brightness-110 disabled:opacity-50'
        } ${!hasContent ? 'disabled:opacity-100' : ''}`}
        aria-label={selected.pending ? `${selected.label}: sending` : selected.ariaLabel}
        aria-busy={selected.pending}
        title={selected.description}
      >
        {selected.pending ? (
          <Loader2 size={16} className="animate-spin motion-reduce:animate-none" />
        ) : iconOnlySend ? (
          <ArrowUp size={19} strokeWidth={2.2} />
        ) : (
          <Icon size={14} />
        )}
        {!iconOnlySend && (selected.pending ? 'Sending…' : selected.shortLabel)}
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
              className="flex h-8 w-8 items-center justify-center rounded-full text-text-tertiary transition-colors duration-150 hover:bg-bg-tertiary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/55 disabled:opacity-50"
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
      className="flex h-10 w-10 items-center justify-center rounded-full text-text-secondary transition-colors duration-150 hover:bg-bg-tertiary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/55 disabled:cursor-not-allowed disabled:opacity-50"
      title="Stop the current run"
      aria-label="Stop current run"
    >
      <Square size={14} fill="currentColor" aria-hidden="true" />
      <span className="sr-only">Stop</span>
    </button>
  );
}
