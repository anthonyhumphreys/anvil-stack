import type { BackendDescriptor } from '../../contract/discovery';
import { DEFAULT_LIMITS, DESCRIPTOR_VERSION, PROTOCOL } from '../../contract/version';

/** Spike deployment identity. Stable so pinning tests stay deterministic. */
export const SPIKE_DEPLOYMENT_ID = 'spike-0000-0000-0000-backend01demo';

/**
 * Public discovery descriptor. Must satisfy `validateDescriptor` in
 * `../contract/discovery.ts`. The spike advertises `sync/1` only; `mesh/1` is
 * advertised once MESH packets land.
 *
 * authModes advertise only what the deployment actually supports:
 * `enrollment-code` always works (admin- or device-issued), and `oidc-pkce`
 * is advertised only when OIDC_ISSUER/OIDC_CLIENT_ID are configured.
 */
export function buildDescriptor(env?: {
  OIDC_ISSUER?: string;
  OIDC_CLIENT_ID?: string;
  OIDC_SCOPES?: string;
}): BackendDescriptor {
  const oidcConfigured =
    typeof env?.OIDC_ISSUER === 'string' &&
    env.OIDC_ISSUER.length > 0 &&
    typeof env?.OIDC_CLIENT_ID === 'string' &&
    env.OIDC_CLIENT_ID.length > 0;
  const scopes = (env?.OIDC_SCOPES ?? 'openid profile')
    .split(/\s+/)
    .filter((scope) => scope.length > 0);
  return {
    descriptorVersion: DESCRIPTOR_VERSION,
    deploymentId: SPIKE_DEPLOYMENT_ID,
    displayName: 'Anvil Backend Spike (BACKEND-01)',
    protocols: [PROTOCOL],
    profiles: ['sync/1'],
    apiPath: 'v1',
    socketPath: 'v1/connect',
    authModes: oidcConfigured ? ['enrollment-code', 'oidc-pkce'] : ['enrollment-code'],
    auth: {
      issuer: oidcConfigured ? (env?.OIDC_ISSUER as string) : 'https://enrollment.invalid',
      publicClientId: oidcConfigured ? (env?.OIDC_CLIENT_ID as string) : 'anvil-desktop',
      scopes: scopes.length > 0 ? scopes : ['openid'],
    },
    limits: {
      entityBytes: DEFAULT_LIMITS.entityBytes,
      pageBytes: DEFAULT_LIMITS.pageBytes,
      batchChanges: DEFAULT_LIMITS.batchChanges,
      liveFrameBytes: DEFAULT_LIMITS.liveFrameBytes,
    },
  };
}
