/**
 * Shared (renderer-safe) contracts for the BYOB-01 generic backend connection
 * (packet "Frozen wire bundle, discovery, built-app generic backend
 * connection"). No secrets cross this boundary: association rows, discovery
 * results, and status snapshots carry endpoint metadata only. Device tokens,
 * refresh credentials, and enrollment codes stay in main-process storage.
 *
 * Types here are structural copies of `cloud/contract` shapes so the renderer
 * bundle never imports the contract package.
 */

export type SyncBackendState = 'active' | 'paused' | 'disconnected';

export type SyncBackendConnectionMode = 'local' | 'hosted' | 'cloudflare' | 'compatible';

export interface SyncBackendLimits {
  entityBytes: number;
  pageBytes: number;
  batchChanges: number;
  liveFrameBytes: number;
}

export interface SyncBackendDescriptor {
  descriptorVersion: number;
  deploymentId: string;
  displayName: string;
  protocols: string[];
  profiles: string[];
  apiPath: string;
  socketPath: string;
  authModes: string[];
  auth: {
    issuer: string;
    publicClientId: string;
    scopes: string[];
  };
  limits: SyncBackendLimits;
}

export interface SyncBackendDiscovery {
  /** User-entered base normalized to a trailing slash. */
  baseUrl: string;
  apiUrl: string;
  socketUrl: string;
  descriptor: SyncBackendDescriptor;
  /** Negotiated limits: the stricter of local defaults and descriptor limits. */
  limits: SyncBackendLimits;
}

export interface SyncBackendPinInput {
  baseUrl: string;
  descriptor: SyncBackendDescriptor;
}

export interface SyncBackendStatus {
  connectionMode: SyncBackendConnectionMode;
  backendId: string | null;
  baseUrl: string | null;
  deploymentId: string | null;
  displayName: string | null;
  profiles: string[];
  authModes: string[];
  state: SyncBackendState | null;
  /** Endpoint or issuer changed under the same deployment ID; re-review needed. */
  identityReviewRequired: boolean;
}

/** Exhaustive label helper so new connection modes fail closed at compile time. */
export function syncBackendModeLabel(mode: SyncBackendConnectionMode): string {
  switch (mode) {
    case 'local':
      return 'Local only';
    case 'hosted':
      return 'Anvil-hosted';
    case 'cloudflare':
      return 'My Cloudflare deployment';
    case 'compatible':
      return 'Compatible backend';
    default: {
      const exhaustive: never = mode;
      return exhaustive;
    }
  }
}
