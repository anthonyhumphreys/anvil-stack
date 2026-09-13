// Generic OIDC/PKCE + enrollment-code device enrollment and device-session
// contract (AUTH-01).
//
// Pure TypeScript: no Node, Electron, or Cloudflare imports. Randomness and
// hashing are injected by the caller so this module stays dependency-free and
// testable in any runtime.
//
// HTTP mapping (documented here because envelope.ts is owned elsewhere):
// every AuthErrorCode maps to HTTP 401 — an invalid proof, a used
// single-use enrollment code, and a reused (already-rotated) refresh token
// are all authentication failures, never 403/409.

/** Frozen desktop OIDC loopback host. Only this literal host is accepted. */
export const OIDC_LOOPBACK_HOST = '127.0.0.1' as const;

/** Frozen desktop OIDC callback path. No extra path segments are accepted. */
export const OIDC_CALLBACK_PATH = '/callback' as const;

/** Ephemeral loopback ports are restricted to this inclusive range. */
export const OIDC_MIN_PORT = 49152 as const;

/** Ephemeral loopback ports are restricted to this inclusive range. */
export const OIDC_MAX_PORT = 65535 as const;

/** The only PKCE challenge method the desktop client uses. */
export const OIDC_CODE_CHALLENGE_METHOD = 'S256' as const;

/** Default scopes for the public desktop client. No client secret is embedded. */
export const OIDC_DEFAULT_SCOPES: readonly string[] = ['openid', 'profile'];

/** Placeholder issuer used until discovery supplies the real authority. */
export const OIDC_PLACEHOLDER_ISSUER = 'https://auth.anvil.example' as const;

/** Placeholder public client id for the desktop app. */
export const OIDC_PLACEHOLDER_CLIENT_ID = 'anvil-desktop' as const;

/** Frozen auth route families (see integration-contract section 5). */
export const AUTH_OPERATIONS = ['enroll', 'session.refresh', 'session.revoke', 'session.describe'] as const;

export type AuthOperation = (typeof AUTH_OPERATIONS)[number];

/** OIDC authorization-code proof presented once at the enroll boundary. */
export interface OidcPkceProof {
  method: 'oidc-pkce';
  issuer: string;
  authorizationCode: string;
  codeVerifier: string;
  redirectUri: string;
  nonce: string;
}

/** Administrator-issued short-lived single-use enrollment proof. */
export interface EnrollmentCodeProof {
  method: 'enrollment-code';
  code: string;
}

/** The only two proofs the built client can present at enrollment. */
export type EnrollProof = OidcPkceProof | EnrollmentCodeProof;

export interface EnrollParams {
  proof: EnrollProof;
  installationId: string;
  displayName?: string;
}

/**
 * Uniform device-scoped session issued after either enrollment method.
 * Bound to account, enrollment, and credential generation; API identity is
 * derived from it, never from caller-supplied owner/device ids.
 */
export interface DeviceSession {
  accessToken: string;
  accessExpiresAt: string;
  refreshToken: string;
  credentialGeneration: number;
  enrollmentId: string;
  accountId: string;
  datasetEpoch: string;
  displayName?: string;
}

export type EnrollResult = DeviceSession;

export interface SessionRefreshParams {
  refreshToken: string;
  enrollmentId: string;
}

/**
 * Rotated session: a new access+refresh pair with an incremented
 * credentialGeneration. The presented refresh token is consumed and must
 * never be accepted again (see AuthErrorCode reuse detection).
 */
export type SessionRefreshResult = DeviceSession;

export interface SessionRevokeParams {
  enrollmentId: string;
  refreshToken?: string;
}

/** Revocation is idempotent: revoking twice still reports revoked. */
export interface SessionRevokeResult {
  revoked: boolean;
}

/**
 * Device-pairing request: a signed-in device (or an administrator holding the
 * deployment admin credential) asks the backend to mint a short-lived
 * single-use enrollment code bound to the session's account.
 */
export interface EnrollmentCodeIssueParams {
  /** Optional human label shown to the operator when issuing for a device. */
  displayName?: string;
}

/** The issued code is returned once and never stored in sync data. */
export interface EnrollmentCodeIssueResult {
  code: string;
  expiresAt: string;
  accountId: string;
}

/**
 * OPS-01 diagnostics: aggregate counters and retention state for the account.
 * Optional so older backends stay compatible; never carries entity content,
 * prompts, paths, or tokens.
 */
export interface SyncAccountStats {
  /** Bytes of retained change history (journal payloads) currently stored. */
  historyBytes: number;
  /** Budget enforced before accepting new shared changes. */
  historyQuotaBytes: number;
  /** Cursors strictly below this sequence must reset and re-scan. */
  retentionFloor: number;
  /**
   * MESH-03: declared bytes held by non-terminal artifact rows
   * (reserved/uploaded/published/deleting) against the account quota.
   */
  artifactBytes?: number;
  counters: Record<string, number>;
}

/** Authenticated identity/epoch view. Never contains tokens. */
export interface SessionDescribeResult {
  accountId: string;
  enrollmentId: string;
  datasetEpoch: string;
  credentialGeneration: number;
  accessExpiresAt: string;
  displayName?: string;
  accountStats?: SyncAccountStats;
}

/**
 * Account-scoped device view (`device.list`). One row per enrolled
 * device session — revoked devices remain listed for audit until the
 * session sweep ages them out. Never carries token material.
 */
export interface DeviceSummary {
  enrollmentId: string;
  displayName?: string;
  installationId: string;
  credentialGeneration: number;
  revoked: boolean;
  createdAt: string;
  /** True when this row is the caller's own session. */
  self: boolean;
}

export interface DeviceListResult {
  devices: DeviceSummary[];
}

export interface DeviceRenameParams {
  enrollmentId: string;
  /** Empty string clears the name back to unset. */
  displayName: string;
}

export interface DeviceRenameResult {
  renamed: boolean;
  enrollmentId: string;
}

export interface DeviceRevokeParams {
  enrollmentId: string;
}

/**
 * Idempotent like session revoke: an already-revoked (or just-revoked)
 * device reports revoked. Unknown enrollments are `not-found`.
 */
export interface DeviceRevokeResult {
  revoked: boolean;
  enrollmentId: string;
}

/**
 * Account deletion lifecycle (spec §140): enrollments disable first,
 * then hosted data purges in bounded retryable passes. `deleting`
 * means the tombstone exists and purge passes are in flight;
 * `deleted` means the account object reported its stores empty.
 * `none` means no deletion has been requested for this account.
 */
export type AccountDeletionState = 'none' | 'deleting' | 'deleted';

export interface AccountDeleteResult {
  state: Exclude<AccountDeletionState, 'none'>;
  deletionGeneration: number;
  startedAt: string;
}

export interface AccountDeletionStatusResult {
  state: AccountDeletionState;
  /** Present once deletion has been requested. */
  deletionGeneration?: number;
  startedAt?: string;
  deletedAt?: string;
  /** Rows purged so far, reported by the account object. */
  purgedRows?: number;
}

/**
 * Auth failure codes owned by this contract (envelope.ts is owned by
 * another packet, so they live here). All three map to HTTP 401.
 */
export type AuthErrorCode = 'refresh-reuse-detected' | 'enrollment-code-used' | 'invalid-proof';

/**
 * HTTP status agreement for auth failures: reuse of an already-rotated
 * refresh token, a consumed enrollment code, and any other invalid proof
 * are all 401 authentication failures.
 */
export function authErrorHttpStatus(code: AuthErrorCode): number {
  switch (code) {
    case 'refresh-reuse-detected':
      return 401;
    case 'enrollment-code-used':
      return 401;
    case 'invalid-proof':
      return 401;
    default: {
      const exhaustive: never = code;
      return exhaustive;
    }
  }
}

const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Base64url-encode bytes with no padding. Pure TS: no Buffer/btoa needed. */
export function base64UrlEncode(bytes: Uint8Array): string {
  let output = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const first = bytes[i];
    const second = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const third = i + 2 < bytes.length ? bytes[i + 2] : 0;
    const remaining = bytes.length - i;
    const triplet = (first << 16) | (second << 8) | third;
    output += BASE64URL_ALPHABET[(triplet >> 18) & 63];
    output += BASE64URL_ALPHABET[(triplet >> 12) & 63];
    if (remaining > 1) {
      output += BASE64URL_ALPHABET[(triplet >> 6) & 63];
    }
    if (remaining > 2) {
      output += BASE64URL_ALPHABET[triplet & 63];
    }
  }
  return output;
}

export interface PkceS256Pair {
  verifier: string;
  challenge: string;
  method: typeof OIDC_CODE_CHALLENGE_METHOD;
}

/**
 * Builds a PKCE S256 pair from 32 injected random bytes. Randomness and the
 * SHA-256 implementation are injected so the contract needs no Node crypto:
 * pass `randomBytes(32)` and `(data) => createHash('sha256').update(data).digest()`.
 * The verifier is ASCII, so it is hashed as its raw byte values.
 */
export function createPkceS256Pair(
  randomBytes32: Uint8Array,
  sha256: (data: Uint8Array) => Uint8Array,
): PkceS256Pair {
  if (randomBytes32.length !== 32) {
    throw new Error('PKCE randomness must be exactly 32 bytes.');
  }
  const verifier = base64UrlEncode(randomBytes32);
  const verifierBytes = new Uint8Array(verifier.length);
  for (let i = 0; i < verifier.length; i += 1) {
    verifierBytes[i] = verifier.charCodeAt(i);
  }
  const challenge = base64UrlEncode(sha256(verifierBytes));
  return { verifier, challenge, method: OIDC_CODE_CHALLENGE_METHOD };
}

/**
 * Builds the frozen loopback redirect URI for an ephemeral port. Throws when
 * the port is outside 49152-65535.
 */
export function buildLoopbackRedirectUri(port: number): string {
  if (!Number.isInteger(port) || port < OIDC_MIN_PORT || port > OIDC_MAX_PORT) {
    throw new Error(`OIDC loopback port must be an integer in ${OIDC_MIN_PORT}-65535.`);
  }
  return `http://${OIDC_LOOPBACK_HOST}:${port}${OIDC_CALLBACK_PATH}`;
}

const LOOPBACK_REDIRECT_PATTERN = /^http:\/\/127\.0\.0\.1:(\d+)\/callback$/;

/**
 * Accepts only the frozen desktop redirect form
 * `http://127.0.0.1:{port}/callback` with an ephemeral port in
 * 49152-65535. Rejects https, other hosts (including localhost and
 * 0.0.0.0), userinfo, extra path segments, trailing slashes, and any
 * query or fragment that could leak the authorization code.
 */
export function isAllowedOidcRedirectUri(uri: string): boolean {
  const match = LOOPBACK_REDIRECT_PATTERN.exec(uri);
  if (!match) {
    return false;
  }
  const port = Number(match[1]);
  return (
    Number.isInteger(port) &&
    port >= OIDC_MIN_PORT &&
    port <= OIDC_MAX_PORT &&
    String(port) === match[1]
  );
}
