import { describe, expect, it } from 'vitest';
import {
  deviceTrustSourceLabel,
  deviceTrustStateLabel,
  securityEventLabel,
} from '../device-security-labels';

describe('device security labels', () => {
  it('keeps automatic trust explicit in the device roster', () => {
    expect(deviceTrustSourceLabel('automatic-auth')).toBe('Trusted automatically');
    expect(deviceTrustSourceLabel('manual-approval')).toBe('Approved by another trusted device');
    expect(deviceTrustSourceLabel('first-device')).toBe('First device');
  });

  it('distinguishes locked-capable trust states from revoked state labels', () => {
    expect(deviceTrustStateLabel('trusted')).toBe('Trusted');
    expect(deviceTrustStateLabel('pending')).toBe('Waiting for approval');
    expect(deviceTrustStateLabel('revoked')).toBe('Revoked');
  });

  it('maps backend security audit actions to user-facing activity labels', () => {
    expect(securityEventLabel('setPolicy', 'accepted:auto-trust-authenticated')).toBe(
      'Policy changed: new devices trusted automatically',
    );
    expect(securityEventLabel('setPolicy', 'accepted:require-approval')).toBe(
      'Policy changed: new devices require approval',
    );
    expect(securityEventLabel('updateRecovery')).toBe('Recovery code replaced');
    expect(securityEventLabel('device-auto-trusted')).toBe('Trusted automatically');
    expect(securityEventLabel('reset')).toBe('Encrypted data reset');
  });
});
