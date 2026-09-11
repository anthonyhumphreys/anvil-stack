import type { BackendDescriptor } from '../../contract/discovery';
import { DEFAULT_LIMITS, DESCRIPTOR_VERSION, PROTOCOL } from '../../contract/version';

/** Spike deployment identity. Stable so pinning tests stay deterministic. */
export const SPIKE_DEPLOYMENT_ID = 'spike-0000-0000-0000-backend01demo';

/**
 * Public discovery descriptor for the spike. Must satisfy
 * `validateDescriptor` in `../contract/discovery.ts`. The spike advertises
 * `sync/1` only; `mesh/1` is advertised once MESH packets land.
 */
export function buildDescriptor(): BackendDescriptor {
  return {
    descriptorVersion: DESCRIPTOR_VERSION,
    deploymentId: SPIKE_DEPLOYMENT_ID,
    displayName: 'Anvil Backend Spike (BACKEND-01)',
    protocols: [PROTOCOL],
    profiles: ['sync/1'],
    apiPath: 'v1',
    socketPath: 'v1/connect',
    authModes: ['enrollment-code'],
    auth: {
      // SPIKE-AUTH: no real issuer; AUTH-01 fills in OIDC or enrollment-code config.
      issuer: 'https://spike.invalid',
      publicClientId: 'anvil-spike',
      scopes: ['openid'],
    },
    limits: {
      entityBytes: DEFAULT_LIMITS.entityBytes,
      pageBytes: DEFAULT_LIMITS.pageBytes,
      batchChanges: DEFAULT_LIMITS.batchChanges,
      liveFrameBytes: DEFAULT_LIMITS.liveFrameBytes,
    },
  };
}
