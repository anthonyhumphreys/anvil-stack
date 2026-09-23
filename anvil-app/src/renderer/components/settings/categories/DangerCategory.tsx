import { useState } from 'react';
import { CheckCircle, Loader2 } from 'lucide-react';
import { Button, ConfirmDialog } from '../../ui';
import { useSettingsContext } from '../SettingsContext';
import { SettingsPanel } from '../settings-ui';

export function DangerCategory() {
  const { reportError } = useSettingsContext();
  const [confirming, setConfirming] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [resetDone, setResetDone] = useState(false);

  const handleResetOnboarding = async () => {
    setResetting(true);
    reportError(null);
    try {
      const result = await window.anvil.settings.resetOnboarding();
      if (result.success) {
        setResetDone(true);
        setTimeout(() => setResetDone(false), 3000);
      } else {
        reportError(result.error ?? 'Failed to reset onboarding');
      }
    } catch (err) {
      reportError(err instanceof Error ? err.message : 'Failed to reset onboarding');
    } finally {
      setResetting(false);
      setConfirming(false);
    }
  };

  return (
    <>
      <SettingsPanel
        panelId="reset"
        title="Reset onboarding"
        description="Run first-run setup again. This clears workspace selections and preferences."
        tone="danger"
      >
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="danger" size="sm" onClick={() => setConfirming(true)}>
            {resetting && <Loader2 size={12} className="animate-spin" />}
            {resetting ? 'Resetting…' : 'Reset onboarding'}
          </Button>
          {resetDone && (
            <span className="flex items-center gap-1 text-sm text-success">
              <CheckCircle size={14} /> Onboarding state cleared
            </span>
          )}
        </div>
      </SettingsPanel>

      <ConfirmDialog
        open={confirming}
        title="Reset onboarding?"
        description="The role picker and connector setup will run again on next launch. Workspace selections and preferences are cleared; repositories and credentials are not affected."
        confirmLabel="Reset onboarding"
        tone="danger"
        loading={resetting}
        onConfirm={() => void handleResetOnboarding()}
        onCancel={() => setConfirming(false)}
      />
    </>
  );
}
