import type { ReactNode } from 'react';
import { CheckCircle, Loader2, XCircle } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { AppSettings } from '../../../shared/types';
import { cx, Button } from '../ui';
import { useSettingsContext } from './SettingsContext';
import { settingsPanelDomId } from './settings-route';

/**
 * Shared presentational pieces for Settings categories (ST6). Panels get a
 * stable `panelId` that becomes a `#anchor` for deep links (ST4) and a
 * `saveKeys` list that drives the per-panel save-status line (ST3).
 */

export type TestStatus = 'idle' | 'testing' | 'ok' | 'error';

export function SettingsCategory({
  id,
  title,
  description,
  icon: Icon,
  children,
}: {
  id: string;
  title: string;
  description: string;
  icon: LucideIcon;
  children: ReactNode;
}) {
  return (
    <section id={`settings-${id}`} className="space-y-3">
      <div className="flex items-start gap-3">
        <div className="rounded-md border border-border-subtle bg-bg-secondary p-2 text-accent">
          <Icon size={18} />
        </div>
        <div className="min-w-0">
          <h3 className="text-lg font-semibold text-text-primary">{title}</h3>
          <p className="text-sm text-text-secondary">{description}</p>
        </div>
      </div>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

/**
 * Inline save status for a set of settings keys: "Unsaved changes" while
 * dirty, "Saving…" while a write is in flight, a "Saved" tick just after one
 * lands. `autosave` adds a quiet "saves automatically" hint when idle.
 */
export function PanelSaveStatus({
  keys,
  autosave = false,
}: {
  keys: ReadonlyArray<keyof AppSettings>;
  autosave?: boolean;
}) {
  const { draft } = useSettingsContext();
  const dirty = keys.some((key) => draft.dirtyKeys.has(key));
  const saving = keys.some((key) => draft.savingKeys.has(key));
  const recentlySaved = keys.some((key) => draft.recentlySavedKeys.has(key));

  if (saving) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-text-tertiary">
        <Loader2 size={12} className="animate-spin" /> Saving…
      </span>
    );
  }
  if (dirty) {
    return <span className="text-xs text-text-tertiary">Unsaved changes</span>;
  }
  if (recentlySaved) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-success">
        <CheckCircle size={12} /> Saved
      </span>
    );
  }
  if (autosave) {
    return <span className="text-xs text-text-tertiary">Changes save automatically</span>;
  }
  return null;
}

export function SettingsPanel({
  title,
  description,
  tone = 'default',
  panelId,
  saveKeys,
  autosave = false,
  children,
}: {
  title: string;
  description?: string;
  tone?: 'default' | 'danger';
  /** Anchor id — reachable as `/settings/:category#<panelId>` (ST4). */
  panelId?: string;
  /** Keys whose dirty/saving/saved state feeds the inline status (ST3). */
  saveKeys?: ReadonlyArray<keyof AppSettings>;
  /** Show a "saves automatically" hint when nothing is dirty. */
  autosave?: boolean;
  children: ReactNode;
}) {
  return (
    <section
      id={panelId ? settingsPanelDomId(panelId) : undefined}
      className={cx(
        'scroll-mt-6 space-y-4 rounded-lg border p-5',
        tone === 'danger' ? 'border-error/30 bg-error/5' : 'border-border bg-bg-secondary',
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h4 className="text-base font-semibold text-text-primary">{title}</h4>
          {description && <p className="mt-1 text-sm text-text-secondary">{description}</p>}
        </div>
        {saveKeys && (
          <div className="shrink-0 pt-0.5">
            <PanelSaveStatus keys={saveKeys} autosave={autosave} />
          </div>
        )}
      </div>
      {children}
    </section>
  );
}

/**
 * Footer for credential panels: explicit Save/Discard for just this panel's
 * keys, so saving a connector never flushes unrelated edits (ST1/ST2).
 */
export function CredentialSaveControls({
  keys,
  onSaved,
}: {
  keys: ReadonlyArray<keyof AppSettings>;
  onSaved?: () => void;
}) {
  const { draft } = useSettingsContext();
  const dirty = keys.filter((key) => draft.dirtyKeys.has(key));
  const saving = keys.some((key) => draft.savingKeys.has(key));
  if (dirty.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-3 border-t border-border-subtle pt-3">
      <span className="text-xs text-text-tertiary">Unsaved changes in this section</span>
      <div className="flex items-center gap-2">
        <Button
          variant="primary"
          size="sm"
          disabled={saving}
          onClick={async () => {
            if (await draft.saveKeys(dirty)) onSaved?.();
          }}
        >
          {saving && <Loader2 size={12} className="animate-spin" />}
          Save
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={saving}
          onClick={() => draft.discardKeys(dirty)}
        >
          Discard
        </Button>
      </div>
    </div>
  );
}

export function Field({
  label,
  value,
  onChange,
  placeholder,
  type = 'text',
  saveKey,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: 'text' | 'password';
  /** When set, renders a per-field saved/dirty tick (ST3). */
  saveKey?: keyof AppSettings;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <label className="block text-sm text-text-secondary">{label}</label>
        {saveKey && <PanelSaveStatus keys={[saveKey]} autosave />}
      </div>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-md border border-border bg-bg-primary px-3 py-1.5 text-sm text-text-primary placeholder:text-text-tertiary focus:border-accent focus:outline-none"
      />
    </div>
  );
}

/**
 * Connection-test button. While the panel's own fields are being persisted
 * ahead of the test it announces "Saving these credentials to test…" (ST2).
 */
export function TestButton({
  status,
  onClick,
  label = 'Test Connection',
  savingCredentials = false,
}: {
  status: TestStatus;
  onClick: () => void;
  label?: string;
  savingCredentials?: boolean;
}) {
  return (
    <div className="flex items-center gap-3">
      <button
        onClick={onClick}
        disabled={status === 'testing' || savingCredentials}
        className="flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm text-text-secondary transition-colors hover:border-text-tertiary hover:text-text-primary disabled:opacity-50"
      >
        {(status === 'testing' || savingCredentials) && (
          <Loader2 size={12} className="animate-spin" />
        )}
        {!savingCredentials && status === 'ok' && (
          <CheckCircle size={12} className="text-success" />
        )}
        {!savingCredentials && status === 'error' && <XCircle size={12} className="text-error" />}
        {label}
      </button>
      {savingCredentials && (
        <span className="text-xs text-text-tertiary">Saving these credentials to test…</span>
      )}
    </div>
  );
}

export function ButtonGrid({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">{children}</div>;
}

export function ProviderButton({
  label,
  description,
  active,
  disabled = false,
  onClick,
}: {
  label: string;
  description: string;
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={cx(
        'min-w-0 flex-1 rounded-lg border p-3 text-left transition-colors sm:min-w-[10rem]',
        active ? 'border-accent bg-accent/10' : 'border-border bg-bg-primary hover:bg-bg-tertiary',
        'disabled:cursor-not-allowed disabled:opacity-50',
      )}
    >
      <div className={cx('text-sm font-medium', active ? 'text-accent' : 'text-text-primary')}>
        {label}
      </div>
      <div className="mt-0.5 text-sm text-text-tertiary">{description}</div>
    </button>
  );
}

export function ReasoningButton({
  label,
  description,
  active,
  onClick,
}: {
  label: string;
  description: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cx(
        'min-w-0 flex-1 rounded-lg border p-3 text-left transition-colors sm:min-w-[9rem]',
        active ? 'border-accent bg-accent/10' : 'border-border bg-bg-primary hover:bg-bg-tertiary',
      )}
    >
      <div className={cx('text-sm font-medium', active ? 'text-accent' : 'text-text-primary')}>
        {label}
      </div>
      <div className="mt-0.5 text-sm text-text-tertiary">{description}</div>
    </button>
  );
}

export function CapabilityChip({ label, active }: { label: string; active: boolean }) {
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs',
        active
          ? 'border-success/40 bg-success/10 text-success'
          : 'border-border-subtle bg-bg-secondary text-text-tertiary',
      )}
    >
      <span
        className={cx('h-1.5 w-1.5 rounded-full', active ? 'bg-success' : 'bg-text-tertiary/50')}
      />
      {label}
    </span>
  );
}

export function SummaryChip({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md bg-bg-primary px-2.5 py-1 text-xs text-text-secondary">
      <span className="text-text-tertiary">{label}</span>
      <span className="font-medium text-text-primary">{value}</span>
    </span>
  );
}

export function MetricTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border-subtle bg-bg-secondary px-3 py-2">
      <div className="text-xs text-text-tertiary">{label}</div>
      <div className="mt-0.5 truncate text-sm font-semibold text-text-primary">{value}</div>
    </div>
  );
}

export function ProgressBar({ percent }: { percent: number }) {
  return (
    <div className="h-2 overflow-hidden rounded-full bg-bg-tertiary">
      <div className="h-full rounded-full bg-accent" style={{ width: `${percent}%` }} />
    </div>
  );
}
