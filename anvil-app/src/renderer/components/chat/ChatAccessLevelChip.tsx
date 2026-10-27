import { useState } from 'react';
import {
  Check,
  ChevronDown,
  ListChecks,
  Lock,
  Shield,
  ShieldAlert,
  ShieldCheck,
} from 'lucide-react';
import type { CodexMode } from '../../../shared/types';
import { ConfirmDialog, Menu, MenuItem, MenuLabel, MenuSeparator, cx } from '../ui';
import {
  chatAccessLevelIsElevated,
  chatAccessLevelLabel,
  chatAccessLevelShortLabel,
  chatAccessOptionSelected,
  chatAccessOptionsForProvider,
  resolveChatAccessChipLabel,
  type ChatAccessOption,
} from './thread-access';

/**
 * CH1 — always-visible per-thread access chip in the composer.
 *
 * Neutral styling for "Read only"/"Ask for extra access"; warning styling + shield
 * for "Auto in workspace"/"Full access". Switching to a level whose transport value
 * is `full-access` requires a ConfirmDialog.
 *
 * H9 — the option list is provider-truthful: Codex-family providers get the
 * four CodexMode levels; ACP providers (Cursor, Devin) get their own mode ids
 * (`ask`, `agent`, `accept-edits`, `smart`, `bypass`, `plan`) mapped onto the
 * closest transport level, plus `appliedMode` so the label shows what the
 * provider actually applies rather than what Anvil requested.
 */
export function ChatAccessLevelChip({
  value,
  onChange,
  disabled = false,
  options,
  appliedMode,
  onSelectOption,
  compact = false,
}: {
  value: CodexMode;
  onChange?: (mode: CodexMode) => void;
  disabled?: boolean;
  /** Provider-specific options; defaults to the four CodexMode levels. */
  options?: ChatAccessOption[];
  /** The provider-side mode actually applied for the session, when known. */
  appliedMode?: string;
  /**
   * Preferred selector — receives the full option so `plan` options can route
   * through the collaboration-mode transport instead of a CodexMode.
   */
  onSelectOption?: (option: ChatAccessOption) => void;
  compact?: boolean;
}) {
  const [confirmTarget, setConfirmTarget] = useState<ChatAccessOption | null>(null);
  const resolvedOptions = options ?? chatAccessOptionsForProvider(undefined);
  const selectedOption = resolvedOptions.find((option) =>
    chatAccessOptionSelected(option, value, appliedMode),
  );
  const chipLabel = resolveChatAccessChipLabel(resolvedOptions, value, appliedMode);
  const elevated = selectedOption?.elevated ?? chatAccessLevelIsElevated(value);

  const select = (option: ChatAccessOption) => {
    if (onSelectOption) {
      onSelectOption(option);
      return;
    }
    if (option.level) onChange?.(option.level);
  };

  const requestSelect = (option: ChatAccessOption) => {
    if (chatAccessOptionSelected(option, value, appliedMode)) return;
    if (option.level === 'full-access') {
      setConfirmTarget(option);
      return;
    }
    select(option);
  };

  return (
    <>
      <Menu
        label="Thread access level"
        align="start"
        side="top"
        trigger={(props) => (
          <button
            {...props}
            type="button"
            disabled={disabled}
            className={cx(
              `flex h-9 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium transition-colors ${compact ? 'max-w-36' : 'max-w-48'}`,
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/55',
              'disabled:cursor-not-allowed disabled:opacity-50',
              elevated
                ? 'bg-warning/10 text-warning'
                : 'text-text-secondary hover:bg-bg-tertiary hover:text-text-primary',
            )}
            title={
              disabled
                ? 'This access level is enforced for the current persona'
                : `Thread access: ${chipLabel}`
            }
            aria-label={`Thread access: ${chipLabel}`}
          >
            {elevated ? (
              <ShieldAlert size={12} className="shrink-0" aria-hidden="true" />
            ) : (
              <Shield size={12} className="shrink-0 text-text-tertiary" aria-hidden="true" />
            )}
            <span className="truncate">{chipLabel}</span>
            <ChevronDown size={11} className="shrink-0 opacity-70" aria-hidden="true" />
          </button>
        )}
        menuClassName="w-80"
      >
        <MenuLabel>Thread access</MenuLabel>
        {resolvedOptions.map((option, index) => {
          const selected = chatAccessOptionSelected(option, value, appliedMode);
          return (
            <div key={option.appliedMode ?? option.level ?? index}>
              {index > 0 && option.elevated && !resolvedOptions[index - 1]?.elevated && (
                <MenuSeparator />
              )}
              <MenuItem
                checked={selected}
                icon={
                  option.level === 'read-only' ? (
                    <Lock size={13} />
                  ) : option.collaborationMode === 'plan' ? (
                    <ListChecks size={13} />
                  ) : option.elevated ? (
                    <ShieldAlert size={13} />
                  ) : (
                    <ShieldCheck size={13} />
                  )
                }
                onSelect={() => requestSelect(option)}
                className={cx(
                  'items-start gap-2.5 [&>svg]:mt-0.5 [&>svg]:shrink-0',
                  'focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60',
                  selected && 'bg-bg-tertiary text-text-primary',
                  option.elevated && '[&>svg]:text-warning',
                )}
              >
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="flex-1 font-medium">{option.label}</span>
                    {selected && (
                      <Check size={14} className="shrink-0 text-accent" aria-hidden="true" />
                    )}
                  </span>
                  <span className="mt-0.5 block text-xs font-normal leading-4 text-text-tertiary">
                    {option.description}
                  </span>
                </span>
              </MenuItem>
            </div>
          );
        })}
      </Menu>

      <ConfirmDialog
        open={confirmTarget !== null}
        title="Allow full access for this thread?"
        description="The agent will be able to run commands and change files anywhere on this machine without asking first. This applies to the current thread only."
        confirmLabel="Allow full access"
        tone="danger"
        onConfirm={() => {
          const target = confirmTarget;
          setConfirmTarget(null);
          if (target) select(target);
        }}
        onCancel={() => setConfirmTarget(null)}
      />
    </>
  );
}

/** Compact read-only level indicator for the thread rail (CH1). */
export function ChatAccessLevelBadge({ level }: { level: CodexMode }) {
  const elevated = chatAccessLevelIsElevated(level);
  return (
    <span
      className={cx(
        'inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-xs font-medium',
        elevated
          ? 'border-warning/35 bg-warning/10 text-warning'
          : 'border-border-subtle text-text-tertiary',
      )}
      title={`Thread access: ${chatAccessLevelLabel(level)}`}
    >
      {elevated ? (
        <ShieldAlert size={10} aria-hidden="true" />
      ) : (
        <Shield size={10} aria-hidden="true" />
      )}
      {chatAccessLevelShortLabel(level)}
    </span>
  );
}
