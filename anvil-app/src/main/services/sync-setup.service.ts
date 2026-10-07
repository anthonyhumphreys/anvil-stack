import { discover, normalizeBaseUrl } from './sync-backend-client.service.js';
import { getBackendStatus, pinBackend } from './sync-backend.service.js';
import { getRuntimeStatus, signInWithOidc } from './sync-runtime.service.js';
import { assertSecretStorageReady } from './auth.service.js';
import type { SyncAuthPublicSnapshot } from '../../shared/sync-runtime.js';

let hostedConnection: Promise<SyncAuthPublicSnapshot> | null = null;

async function connect(): Promise<SyncAuthPublicSnapshot> {
  const before = getBackendStatus();
  if (!before.hostedBackendUrl) {
    throw new Error(
      'Anvil sign-in is unavailable in this build. Choose a custom service in settings.',
    );
  }
  const endpoint = normalizeBaseUrl(before.hostedBackendUrl);
  const runtime = getRuntimeStatus();
  // Pinned endpoints are already normalized, including custom loopback HTTP
  // services. Comparing them must not revalidate one as a hosted HTTPS URL.
  const sameService = before.baseUrl === endpoint;
  if (before.identityReviewRequired) {
    throw new Error('The service identity has changed. Review it in settings before signing in.');
  }
  if (runtime.auth.state === 'signed-in' && !runtime.sessionExpired) {
    if (sameService) return runtime.auth;
    throw new Error('Disconnect your current service in settings before signing in to Anvil.');
  }
  if (before.state === 'active' && !sameService) {
    throw new Error('Disconnect your current service in settings before signing in to Anvil.');
  }

  // Do not make a discovery request or persist a backend pin unless the
  // eventual session can be encrypted on this device.
  assertSecretStorageReady();
  const discovered = await discover(endpoint);
  // Discovery can await a network response. Reject a concurrent account or
  // service change instead of overwriting it with the result of an old action.
  const current = getBackendStatus();
  const currentAuth = getRuntimeStatus().auth;
  if (
    current.backendId !== before.backendId ||
    current.baseUrl !== before.baseUrl ||
    current.identityReviewRequired ||
    currentAuth.state !== runtime.auth.state ||
    currentAuth.accountId !== runtime.auth.accountId ||
    currentAuth.enrollmentId !== runtime.auth.enrollmentId
  ) {
    throw new Error('Your connection changed during setup. Try signing in again.');
  }
  // Storage can be locked while discovery is in flight. Recheck immediately
  // before pinBackend writes the discovered service.
  assertSecretStorageReady();
  const pinned = pinBackend({
    baseUrl: discovered.baseUrl,
    descriptor: discovered.descriptor,
    connectionMode: 'hosted',
  });
  if (pinned.identityReviewRequired) {
    throw new Error('The service identity has changed. Review it in settings before signing in.');
  }
  if (getBackendStatus().backendId !== pinned.id) {
    throw new Error('Your connection changed during setup. Try signing in again.');
  }
  // Pinning remains paused. Upload and worker permission need separate consent.
  return signInWithOidc();
}

/** Discover the build's hosted service and sign in with one user action. */
export function connectHostedSync(): Promise<SyncAuthPublicSnapshot> {
  if (hostedConnection !== null) return hostedConnection;
  hostedConnection = connect().finally(() => {
    hostedConnection = null;
  });
  return hostedConnection;
}
