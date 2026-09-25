// Companion surface contract (MOB-01): account-scoped presence, endpoint
// advertisement, and cross-device attestation for companion clients
// (mobile, Raycast, and other surfaces that control enrolled hosts).
//
// Presence is ephemeral metadata on the account object: TTL'd
// advertisements and live socket attachments, never sync changes and
// never durable entities. A companion attests to a host by presenting
// its own device access token; the host verifies it through
// `session.attest`, which answers the token's verified identity claims
// and never echoes the token back.

export const COMPANION_PROTOCOL_VERSION = 1;

/** How long an endpoint advertisement stays fresh after its last publish. */
export const COMPANION_ADVERTISEMENT_TTL_MS = 30 * 60 * 1000;

export const COMPANION_MAX_ENDPOINTS = 8;
export const COMPANION_MAX_HOST_CHARS = 253;

/**
 * Direct-transport endpoint kinds in dial preference order. Tailscale is
 * preferred over LAN for transport security (WireGuard vs. cleartext
 * bearer); loopback only ever applies to same-machine clients.
 */
export const COMPANION_ENDPOINT_KINDS = ['tailscale', 'lan', 'loopback'] as const;

export type CompanionEndpointKind = (typeof COMPANION_ENDPOINT_KINDS)[number];

export interface CompanionEndpoint {
  kind: CompanionEndpointKind;
  /** IP literal or DNS name. Never a URL — scheme and path are rejected. */
  host: string;
  port: number;
}

/**
 * Cumulative capability tiers a host may offer over its companion API.
 * Enrollment grants reachability; the host's local policy decides which
 * of these a given enrollment actually receives
 * (auto-authenticate ≠ auto-authorize).
 */
export const COMPANION_CAPABILITIES = ['observe', 'approve', 'steer'] as const;

export type CompanionCapability = (typeof COMPANION_CAPABILITIES)[number];

/**
 * `device.advertise`: the calling device publishes its own companion
 * endpoints and offered capabilities. Enrollment identity is derived from
 * the authenticated session — a caller can only ever advertise itself.
 */
export interface DeviceAdvertiseParams {
  endpoints: CompanionEndpoint[];
  capabilities: CompanionCapability[];
  /** Advertised companion protocol; defaults to COMPANION_PROTOCOL_VERSION. */
  protocol?: number;
}

export type DeviceAdvertiseResult = { advertised: true };

export interface DevicePresenceEntry {
  enrollmentId: string;
  /** True while the enrollment holds a live socket on the account object. */
  online: boolean;
  /** Last time the account object saw this enrollment (socket or publish). */
  lastSeenAt: string;
  /** Present only while the entry is online or the advertisement is fresh. */
  endpoints?: CompanionEndpoint[];
  capabilities?: CompanionCapability[];
  protocol?: number;
  /** True when this row is the caller's own enrollment. */
  self: boolean;
}

export interface DevicePresenceResult {
  devices: DevicePresenceEntry[];
}

/**
 * `session.attest`: a host presents a companion's device access token and
 * receives its verified claims. This is a lookup, not a grant — the host
 * learns the same {accountId, enrollmentId} the worker uses for routing,
 * and an invalid/expired/revoked token fails `unauthenticated`.
 */
export interface SessionAttestParams {
  accessToken: string;
}

export interface SessionAttestResult {
  accountId: string;
  enrollmentId: string;
}

function isEndpointKind(value: unknown): value is CompanionEndpointKind {
  return (
    typeof value === 'string' &&
    (COMPANION_ENDPOINT_KINDS as readonly string[]).includes(value)
  );
}

function isCapability(value: unknown): value is CompanionCapability {
  return (
    typeof value === 'string' && (COMPANION_CAPABILITIES as readonly string[]).includes(value)
  );
}

function isEndpoint(value: unknown): value is CompanionEndpoint {
  if (typeof value !== 'object' || value === null) return false;
  const input = value as Record<string, unknown>;
  return (
    isEndpointKind(input['kind']) &&
    typeof input['host'] === 'string' &&
    input['host'].length > 0 &&
    input['host'].length <= COMPANION_MAX_HOST_CHARS &&
    !input['host'].includes('://') &&
    !input['host'].includes('/') &&
    Number.isInteger(input['port']) &&
    (input['port'] as number) >= 1 &&
    (input['port'] as number) <= 65535
  );
}

export function validateDeviceAdvertiseParams(value: unknown): value is DeviceAdvertiseParams {
  if (typeof value !== 'object' || value === null) return false;
  const input = value as Record<string, unknown>;
  if (!Array.isArray(input['endpoints']) || input['endpoints'].length > COMPANION_MAX_ENDPOINTS) {
    return false;
  }
  if (!input['endpoints'].every(isEndpoint)) return false;
  if (!Array.isArray(input['capabilities']) || !input['capabilities'].every(isCapability)) {
    return false;
  }
  if (input['protocol'] !== undefined) {
    if (!Number.isInteger(input['protocol']) || (input['protocol'] as number) < 1) return false;
  }
  return true;
}

export function validateSessionAttestParams(value: unknown): value is SessionAttestParams {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>)['accessToken'] === 'string' &&
    ((value as Record<string, unknown>)['accessToken'] as string).length > 0
  );
}
