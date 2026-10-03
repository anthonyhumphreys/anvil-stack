import { useEffect, useState } from 'react';
import { useBrand } from '../../contexts/BrandContext';
import type { UserRole } from '../../../shared/types';
import { RoleOptionList } from './RolePickerOverlay';
import { ConnectorSetupOverlay } from './ConnectorSetupOverlay';
import { OnboardingPreviewBar } from './OnboardingPreviewBar';

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
  /** Called when the agent step finishes (Continue) — onboarding proceeds to the workspace creator. */
  onComplete: () => void;
  preview?: boolean;
  onExitPreview?: () => void;
}

/**
 * O1/O4/O5: merged first-run Welcome — one screen for role selection followed
 * by primary-agent setup, with a two-step progress indicator, a Back button
 * (O3), and a visible connection-test result (via the agent card's Test
 * button). Work Items, Git provider and Confluence are intentionally NOT
 * here — they surface at point of need (WorkItemsView, the Clone tab, and
 * DocsView) per O2/3.2.
 */
export function WelcomeOverlay({
  onRoleSelected,
  onComplete,
  preview = false,
  onExitPreview,
}: WelcomeOverlayProps) {
  const brand = useBrand();
  const [step, setStep] = useState<1 | 2>(1);

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
    setStep(2);
  };

  if (step === 2) {
    return (
      <ConnectorSetupOverlay
        preview={preview}
        onExitPreview={onExitPreview}
        sections={['llm']}
        stepLabel="Step 2 of 2"
        title="Set up your primary agent"
        subtitle="The agent powers chat and repo work. Work items, Git providers, and docs connect later — Anvil asks when you reach for them."
        onBack={() => setStep(1)}
        onContinue={() => {
          if (!preview) trackActivation('onboarding_step_completed', { step: 'agent' });
          onComplete();
        }}
      />
    );
  }

  return (
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
            Step 1 of 2
          </p>
          <p className="mt-1 text-sm text-text-secondary">What best describes your role?</p>
        </div>

        <RoleOptionList onSelect={(role) => void handleRole(role)} />
      </div>
    </div>
  );
}
