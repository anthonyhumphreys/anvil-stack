import { describe, expect, it } from 'vitest';
import { presentSetupError } from '../setup-error';

describe('setup errors', () => {
  it('removes the IPC wrapper shown in first-run errors and keeps the recovery advice', () => {
    expect(
      presentSetupError(
        new Error(
          "Error invoking remote method 'sync-runtime:connect-hosted': Error: Unlock your encrypted credential vault before signing in.",
        ),
        'Could not sign in.',
      ),
    ).toBe('Unlock your encrypted credential vault before signing in.');
  });
  it('keeps plain service messages and supplies a useful fallback for empty failures', () => {
    expect(presentSetupError(new Error('Check your passphrase.'), 'Try again.')).toBe(
      'Check your passphrase.',
    );
    expect(presentSetupError(new Error(''), 'Try again.')).toBe('Try again.');
    expect(presentSetupError(null, 'Try again.')).toBe('Try again.');
  });
});
