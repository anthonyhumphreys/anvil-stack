import type { BackendDescriptor } from '../../contract/discovery';
import { DEFAULT_LIMITS, DESCRIPTOR_VERSION, PROTOCOL } from '../../contract/version';
import { isWorkosAuthKitIssuer } from './oidc';

/** Legacy staging identity. Keep until the staging deployment is intentionally migrated. */
export const SPIKE_DEPLOYMENT_ID = 'spike-0000-0000-0000-backend01demo';
export const SPIKE_DEPLOYMENT_NAME = 'Anvil Backend Spike (BACKEND-01)';

type DescriptorEnvironment = {
  ANVIL_DEPLOYMENT_ID?: string;
  ANVIL_DEPLOYMENT_NAME?: string;
  HOSTED_DB?: unknown;
  OIDC_ISSUER?: string;
  OIDC_CLIENT_ID?: string;
  OIDC_SCOPES?: string;
};

/**
 * Public discovery descriptor. Must satisfy `validateDescriptor` in
 * `../contract/discovery.ts`. sync/2 requires encrypted snapshot recovery;
 * mesh/2 adds the compact history and batched cancellation contract.
 *
 * authModes advertise only what the deployment actually supports. Hosted
 * accounts and WorkOS deployments use provider sign-in; human enrollment
 * codes remain available to non-hosted, non-WorkOS deployments.
 */
export function buildDescriptor(env?: DescriptorEnvironment): BackendDescriptor {
  const issuer = env?.OIDC_ISSUER?.trim();
  const clientId = env?.OIDC_CLIENT_ID?.trim();
  const oidcConfigured =
    typeof issuer === 'string' &&
    issuer.length > 0 &&
    typeof clientId === 'string' &&
    clientId.length > 0;
  const workosIssuer = typeof issuer === 'string' && isWorkosAuthKitIssuer(issuer);
  const workosConfigured = oidcConfigured && workosIssuer;
  const canUseEnrollmentCodes = env?.HOSTED_DB === undefined && !workosIssuer;
  const scopes = (env?.OIDC_SCOPES ?? 'openid profile')
    .split(/\s+/)
    .filter((scope) => scope.length > 0);
  return {
    descriptorVersion: DESCRIPTOR_VERSION,
    deploymentId: env?.ANVIL_DEPLOYMENT_ID?.trim() || SPIKE_DEPLOYMENT_ID,
    displayName: env?.ANVIL_DEPLOYMENT_NAME?.trim() || SPIKE_DEPLOYMENT_NAME,
    protocols: [PROTOCOL],
    profiles: ['sync/2', 'mesh/2'],
    features: ['browser-workspace/1'],
    apiPath: 'v1',
    socketPath: 'v1/connect',
    authModes: [
      ...(canUseEnrollmentCodes ? (['enrollment-code'] as const) : []),
      ...(oidcConfigured ? (['oidc-pkce'] as const) : []),
      ...(workosConfigured ? (['workos-device'] as const) : []),
    ],
    auth: {
      issuer: oidcConfigured ? (issuer as string) : 'https://enrollment.invalid',
      publicClientId: oidcConfigured ? (clientId as string) : 'anvil-desktop',
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
