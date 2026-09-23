import { ShieldCheck } from 'lucide-react';
import { useSettingsContext } from '../SettingsContext';
import { SettingsPanel } from '../settings-ui';

export function PrivacyCategory() {
  const { draft } = useSettingsContext();

  return (
    <SettingsPanel
      panelId="telemetry"
      title="Help improve Anvil"
      description="Crash reports help identify failures that are difficult to reproduce locally."
      saveKeys={['telemetryEnabled']}
      autosave
    >
      <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border bg-bg-primary p-4 transition-colors hover:bg-bg-tertiary">
        <input
          type="checkbox"
          checked={draft.settings.telemetryEnabled ?? false}
          onChange={(event) => draft.update('telemetryEnabled', event.target.checked)}
          className="mt-1 h-4 w-4 accent-accent"
        />
        <span className="min-w-0">
          <span className="flex items-center gap-2 text-sm font-medium text-text-primary">
            <ShieldCheck size={15} className="text-accent" />
            Send crash reports
          </span>
          <span className="mt-1 block text-sm leading-relaxed text-text-secondary">
            Sends error stack traces, the Anvil version, and operating-system details to Sentry.
            Reports do not include screenshots, interaction history, or attached repository files.
          </span>
        </span>
      </label>
      <p className="text-xs leading-relaxed text-text-tertiary">
        Off by default. Restart Anvil for a change to take effect. Error stack traces may contain
        local file paths.
      </p>
    </SettingsPanel>
  );
}
