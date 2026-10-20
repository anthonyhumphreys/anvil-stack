import { normalizeBaseUrl } from './sync-backend-client.service.js';

export type DeploymentEnvironment = 'staging' | 'production';

export interface HostedBackendEnvironment {
  deploymentEnv: string | undefined;
  stagingUrl: string | undefined;
  productionUrl: string | undefined;
  /** Pre-split compatibility setting. It is only honored by staging. */
  legacyUrl: string | undefined;
}

/**
 * Resolves the public hosted endpoint for the app's deployment environment.
 * An absent deployment setting keeps existing builds on staging. An invalid
 * explicit value fails closed. Production never reads either staging URL.
 */
export function resolveHostedBackendUrl(environment: HostedBackendEnvironment): string | null {
  const deploymentEnv = parseDeploymentEnvironment(environment.deploymentEnv);
  if (!deploymentEnv) return null;

  const configured =
    deploymentEnv === 'production'
      ? environment.productionUrl?.trim()
      : environment.stagingUrl?.trim() || environment.legacyUrl?.trim();
  if (!configured) return null;

  try {
    const parsed = new URL(normalizeBaseUrl(configured));
    return parsed.protocol === 'https:' ? parsed.href : null;
  } catch {
    return null;
  }
}

function parseDeploymentEnvironment(value: string | undefined): DeploymentEnvironment | null {
  if (value === undefined) return 'staging';
  const normalized = value.trim().toLowerCase();
  if (normalized === 'staging' || normalized === 'production') return normalized;
  return null;
}
