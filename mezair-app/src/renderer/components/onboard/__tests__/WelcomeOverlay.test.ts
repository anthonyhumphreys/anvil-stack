import { describe, expect, it } from 'vitest';
import { transitionWelcomeStep } from '../WelcomeOverlay';

describe('welcome onboarding flow', () => {
  it('continues from role to agent to optional Sync, then completes', () => {
    expect(transitionWelcomeStep('role', 'continue')).toBe('agent');
    expect(transitionWelcomeStep('agent', 'continue')).toBe('sync');
    expect(transitionWelcomeStep('sync', 'continue')).toBe('complete');
  });

  it('returns to the previous setup stage without losing the selected role or agent step', () => {
    expect(transitionWelcomeStep('sync', 'back')).toBe('agent');
    expect(transitionWelcomeStep('agent', 'back')).toBe('role');
  });

  it('offers the local-only completion choice on Sync, not on required setup stages', () => {
    expect(transitionWelcomeStep('sync', 'use-on-this-device')).toBe('complete');
    expect(transitionWelcomeStep('agent', 'use-on-this-device')).toBe('agent');
    expect(transitionWelcomeStep('role', 'use-on-this-device')).toBe('role');
  });
});
