// Backend authentication helpers (AUTH-01).
//
// Real device sessions are opaque bearer tokens issued by the
// SessionCoordinator (`anvil_at_…` access, `anvil_rt_…` refresh). Only their
// SHA-256 hashes are stored. The spike bearer remains, but ONLY when the
// `ANVIL_DEV_SPIKE` var is set — production deploys must leave it unset so the
// spike format fails closed.
//
// The account route is ALWAYS derived from the validated session. The Worker
// and the Durable Object never accept a client-selected tenant/account field
// as authority for routing.

import { base64UrlEncode, type EnrollmentClass } from '../../contract/auth';

export interface SpikeAuth {
  accountId: string;
  enrollmentId: string;
  /** ENV-01: absent means 'device' (spike auth and pre-class backends). */
  enrollmentClass?: EnrollmentClass;
  /** ENV-01: environment record the session is bound to, when any. */
  environmentId?: string;
}

/** Verified device identity the Worker attaches to internal DO requests. */
export interface VerifiedAuth {
  accountId: string;
  enrollmentId: string;
  /** ENV-01: absent means 'device' (spike auth and pre-class backends). */
  enrollmentClass?: EnrollmentClass;
  /** ENV-01: environment record the session is bound to, when any. */
  environmentId?: string;
}

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const TOKEN_PATTERN = /^anvil_(at|rt)_[A-Za-z0-9_-]{32,128}$/;

/**
 * SPIKE-AUTH: parse the spike bearer. Returns null when the header is
 * missing or malformed; callers map null to `unauthenticated` (HTTP 401).
 * Accepted only under the `ANVIL_DEV_SPIKE` development flag.
 */
export function parseSpikeAuth(header: string | null): SpikeAuth | null {
  if (header === null) {
    return null;
  }
  const match = /^Bearer\s+spike:([^:\s]+):([^:\s]+)\s*$/.exec(header);
  if (match === null) {
    return null;
  }
  const accountId = match[1];
  const enrollmentId = match[2];
  if (accountId === undefined || enrollmentId === undefined) {
    return null;
  }
  if (!ID_PATTERN.test(accountId) || !ID_PATTERN.test(enrollmentId)) {
    return null;
  }
  return { accountId, enrollmentId };
}

/** Extracts an opaque `anvil_at_*`/`anvil_rt_*` bearer, or null. */
export function parseDeviceBearer(header: string | null): string | null {
  if (header === null) {
    return null;
  }
  const match = /^Bearer\s+(anvil_(?:at|rt)_[A-Za-z0-9_-]+)\s*$/.exec(header);
  const token = match?.[1];
  if (token === undefined || !TOKEN_PATTERN.test(token)) {
    return null;
  }
  return token;
}

/** Generates an opaque device token with the given contract prefix. */
export function generateDeviceToken(kind: 'at' | 'rt'): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `anvil_${kind}_${base64UrlEncode(bytes)}`;
}

/**
 * Reads the worker-verified identity headers attached to internal DO
 * requests. Returns null when absent or malformed; the DO then falls back to
 * its own credential check.
 */
export function parseVerifiedAuth(request: Request): VerifiedAuth | null {
  const accountId = request.headers.get('x-anvil-account');
  const enrollmentId = request.headers.get('x-anvil-enrollment');
  if (
    typeof accountId !== 'string' ||
    typeof enrollmentId !== 'string' ||
    !ID_PATTERN.test(accountId) ||
    !ID_PATTERN.test(enrollmentId)
  ) {
    return null;
  }
  // ENV-01: the worker forwards the session's enrollment class. Anything
  // outside the two contract values fails closed to 'device' privileges.
  const rawClass = request.headers.get('x-anvil-enrollment-class');
  const enrollmentClass: EnrollmentClass = rawClass === 'ephemeral' ? 'ephemeral' : 'device';
  // ENV-01: the environment binding is a verified session fact too — the
  // account object pins it on first sight like the class.
  const rawEnvironmentId = request.headers.get('x-anvil-environment-id');
  const environmentId =
    typeof rawEnvironmentId === 'string' && ID_PATTERN.test(rawEnvironmentId)
      ? rawEnvironmentId
      : undefined;
  return {
    accountId,
    enrollmentId,
    enrollmentClass,
    ...(environmentId === undefined ? {} : { environmentId }),
  };
}
