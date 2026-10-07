import { useEffect, useState } from 'react';
import { useBrand } from '../../contexts/BrandContext';
import type { UserRole } from '../../../shared/types';
import { RoleOptionList } from './RolePickerOverlay';
import { ConnectorSetupOverlay } from './ConnectorSetupOverlay';
import { OnboardingPreviewBar } from './OnboardingPreviewBar';
import { SyncMeshSetupCard } from './SyncMeshSetupCard';

export type WelcomeStep = 'role' | 'agent' | 'sync';

export function transitionWelcomeStep(
  step: WelcomeStep,
  action: 'back' | 'continue' | 'use-on-this-device',
): WelcomeStep | 'complete' {
  if (action === 'back') {
    if (step === 'sync') return 'agent';
    return 'role';
  }

  if (action === 'use-on-this-device') {
    return step === 'sync' ? 'complete' : step;
  }

  if (step === 'role') return 'agent';
  if (step === 'agent') return 'sync';
  return 'complete';
}

/** §7 funnel — local-only activation events; never transmitted. */
function trackActivation(event: string, payload?: Record<string, unknown>): void {
  try {
    void window.anvil.metrics.track(event, payload).catch(() => {});
  } catch {
    /* metrics must never break onboarding */
  }
}

/** `onboarding_started` fires once per app run, not per overlay remount. */
let onboardingStartedTracked = false;

interface WelcomeOverlayProps {
  onRoleSelected: (role: UserRole) => void;
  /** Called after connecting Sync or choosing local use; proceeds to the workspace creator. */
  onComplete: () => void;
  preview?: boolean;
  onExitPreview?: () => void;
}

/**
 * First-run Welcome keeps the required role and primary-agent setup together,
 * then offers Sync as a separate optional step. Work Items, Git provider and
 * Confluence surface at point of need (WorkItemsView, the Clone tab, and
 * DocsView) per O2/3.2.
 */
export function WelcomeOverlay({
  onRoleSelected,
  onComplete,
  preview = false,
  onExitPreview,
}: WelcomeOverlayProps) {
  const brand = useBrand();
  const [step, setStep] = useState<WelcomeStep>('role');
  const [recoveryCodePending, setRecoveryCodePending] = useState(false);
  const move = (current: WelcomeStep, action: 'back' | 'continue'): void => {
    const next = transitionWelcomeStep(current, action);
    if (next !== 'complete') setStep(next);
  };

  useEffect(() => {
    if (preview || onboardingStartedTracked) return;
    onboardingStartedTracked = true;
    trackActivation('onboarding_started');
  }, [preview]);

  const handleRole = async (role: UserRole) => {
    if (!preview) {
      try {
        await window.anvil.settings.update({ userRole: role });
      } catch (err) {
        console.error('[WelcomeOverlay] Failed to save role:', err);
      }
      trackActivation('onboarding_step_completed', { step: 'role' });
    }
    onRoleSelected(role);
    move('role', 'continue');
  };

  const completeSyncStep = (
    action: 'continue' | 'use-on-this-device',
    choice: 'sync' | 'local',
  ): void => {
    if (transitionWelcomeStep('sync', action) !== 'complete') return;
    if (!preview) trackActivation('onboarding_step_completed', { step: 'sync', choice });
    onComplete();
  };

  return (
    <>
      {step === 'role' ? (
        <div
          className={`flex h-screen items-start justify-center overflow-y-auto bg-bg-primary sm:items-center ${
            preview ? 'py-24' : 'py-14'
          }`}
        >
          <div className="titlebar-drag fixed inset-x-0 top-0 h-10" />
          {preview && onExitPreview && <OnboardingPreviewBar onExit={onExitPreview} />}
          <div className="w-full max-w-md space-y-6 px-6">
            <div className="text-center">
              <h1 className="text-2xl font-bold text-accent">Welcome to {brand.appName}</h1>
              <p className="mt-1 text-eyebrow font-semibold uppercase tracking-wider text-text-tertiary">
                Step 1 of 3
              </p>
              <p className="mt-1 text-sm text-text-secondary">What best describes your role?</p>
            </div>

            <RoleOptionList onSelect={(role) => void handleRole(role)} />
          </div>
        </div>
      ) : (
        <div className={step === 'agent' ? 'block' : 'hidden'}>
          <ConnectorSetupOverlay
            preview={preview}
            onExitPreview={onExitPreview}
            sections={['llm']}
            stepLabel="Step 2 of 3"
            title="Set up your primary agent"
            subtitle="The agent powers chat and repo work. Work items, Git providers, and docs connect later — Anvil asks when you reach for them."
            onBack={() => move('agent', 'back')}
            onContinue={() => {
              if (!preview) trackActivation('onboarding_step_completed', { step: 'agent' });
              move('agent', 'continue');
            }}
          />
        </div>
      )}

      {step === 'sync' && (
        <div
          className={`flex h-screen items-start justify-center overflow-y-auto bg-bg-primary sm:items-center ${
            preview ? 'py-24' : 'py-14'
          }`}
        >
          <div className="titlebar-drag fixed inset-x-0 top-0 h-10" />
          {preview && onExitPreview && <OnboardingPreviewBar onExit={onExitPreview} />}
          <div className="w-full max-w-xl space-y-5 px-6">
            <div className="text-center">
              <p className="text-eyebrow font-semibold uppercase tracking-wider text-text-tertiary">
                Step 3 of 3
              </p>
              <h1 className="mt-1 text-2xl font-bold text-text-primary">Sync across devices</h1>
              <p className="mt-2 text-sm leading-relaxed text-text-secondary">
                Sign in to keep selected Anvil settings and workspace definitions available on your
                other devices. Repository checkouts stay on this computer. You choose which
                workspaces to sync, and this device only runs Mesh jobs if you allow it.
              </p>
            </div>

            <SyncMeshSetupCard
              preview={preview}
              onUseOnDevice={() => completeSyncStep('use-on-this-device', 'local')}
              onContinue={() => completeSyncStep('continue', 'sync')}
              onRecoveryCodePendingChange={setRecoveryCodePending}
            />

            <div className="flex justify-start">
              <button
                type="button"
                onClick={() => move('sync', 'back')}
                disabled={recoveryCodePending}
                className="rounded-lg border border-border px-3 py-2 text-sm text-text-secondary transition-colors hover:bg-bg-secondary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg-primary disabled:cursor-not-allowed disabled:opacity-50"
              >
                Back to agent setup
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
