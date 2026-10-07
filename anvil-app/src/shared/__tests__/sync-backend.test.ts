import { describe, expect, it } from 'vitest';
import { requiresDeviceProviderSignIn } from '../sync-backend';

const selfHosted = {
  connectionMode: 'compatible' as const,
  authModes: ['enrollment-code'],
  baseUrl: 'https://sync.example.test/',
  hostedBackendUrl: 'https://hosted.example.test/',
};

describe('human device sign-in', () => {
  it('preserves code enrollment on a self-hosted service', () => {
    expect(requiresDeviceProviderSignIn(selfHosted)).toBe(false);
  });

  it('requires provider sign-in for hosted mode with an older descriptor', () => {
    expect(requiresDeviceProviderSignIn({ ...selfHosted, connectionMode: 'hosted' })).toBe(true);
  });

  it('requires provider sign-in for WorkOS even in custom service mode', () => {
    expect(
      requiresDeviceProviderSignIn({
        ...selfHosted,
        authModes: ['enrollment-code', 'oidc-pkce', 'workos-device'],
      }),
    ).toBe(true);
  });

  it('recognizes the configured hosted URL regardless of its selected mode or trailing slash', () => {
    expect(
      requiresDeviceProviderSignIn({
        ...selfHosted,
        connectionMode: 'local',
        baseUrl: 'https://hosted.example.test',
      }),
    ).toBe(true);
  });

  it('does not mistake another deployment path for the hosted service', () => {
    expect(
      requiresDeviceProviderSignIn({
        ...selfHosted,
        baseUrl: 'https://hosted.example.test/self-hosted/',
      }),
    ).toBe(false);
  });
});
