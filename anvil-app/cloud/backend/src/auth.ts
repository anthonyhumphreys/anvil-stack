// SPIKE-AUTH: placeholder bearer auth for the BACKEND-01 spike.
//
// Format: `Authorization: Bearer spike:<accountId>:<enrollmentId>`.
// AUTH-01 replaces every helper in this file with OIDC/enrollment-code
// device sessions (short-lived access token + rotating refresh credential,
// generation fencing, revocation). Nothing here is production auth.
//
// The account route is ALWAYS derived from this bearer. The Worker and the
// Durable Object never accept a client-selected tenant/account field as
// authority for routing.

export interface SpikeAuth {
  accountId: string;
  enrollmentId: string;
}

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * SPIKE-AUTH: parse the spike bearer. Returns null when the header is
 * missing or malformed; callers map null to `unauthenticated` (HTTP 401).
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
