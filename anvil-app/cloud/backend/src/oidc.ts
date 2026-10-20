// Server-side OIDC authorization-code + PKCE verification (AUTH-01).
//
// The backend exchanges the desktop's authorization code at the configured
// issuer's token endpoint, then verifies the returned id_token signature
// against the issuer JWKS plus the iss/aud/exp/nonce claims. The account
// identity is derived from the verified `sub`, never from caller input.
//
// `fetch` is injectable so tests can serve a real issuer shape (metadata,
// token endpoint, JWKS with a generated key) without live network access.

import type { OidcPkceProof, WorkosDeviceProof } from '../../contract/auth';
import { isRecord } from './rpc';

export interface OidcAuthorityConfig {
  issuer: string;
  clientId: string;
}

interface OidcMetadata {
  tokenEndpoint: string;
  jwksUri: string;
}

interface JwkKey {
  kty: string;
  kid?: string;
  alg?: string;
  use?: string;
  [key: string]: unknown;
}

function base64UrlDecode(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function decodeJson(base64url: string): Record<string, unknown> | null {
  try {
    const text = new TextDecoder().decode(base64UrlDecode(base64url));
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function fetchJson(
  url: string,
  fetchFn: typeof fetch,
  init?: RequestInit,
): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetchFn(url, init);
    if (!response.ok) {
      return null;
    }
    const payload: unknown = await response.json();
    return isRecord(payload) ? payload : null;
  } catch {
    return null;
  }
}

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end -= 1;
  return value.slice(0, end);
}

/** WorkOS AuthKit's public-client API is not an OIDC discovery issuer: its
 * authorization and code exchange live at /user_management/{authorize,authenticate}
 * and the exchange returns a verified user object rather than an id_token. */
export function isWorkosAuthKitIssuer(issuer: string): boolean {
  try {
    const url = new URL(issuer);
    return (
      url.protocol === 'https:' &&
      url.hostname === 'api.workos.com' &&
      url.pathname === '/user_management' &&
      url.username === '' &&
      url.password === '' &&
      url.search === '' &&
      url.hash === ''
    );
  } catch {
    return false;
  }
}

/**
 * Discovers the issuer's token and JWKS endpoints via RFC 8414 metadata.
 * The metadata document must declare the same issuer string it was fetched
 * under, so a mismatched authority cannot redirect proof verification.
 */
async function fetchOidcMetadata(
  issuer: string,
  fetchFn: typeof fetch,
): Promise<OidcMetadata | null> {
  const base = trimTrailingSlashes(issuer);
  const metadata = await fetchJson(`${base}/.well-known/openid-configuration`, fetchFn);
  if (metadata === null) {
    return null;
  }
  const tokenEndpoint = metadata['token_endpoint'];
  const jwksUri = metadata['jwks_uri'];
  const declaredIssuer = metadata['issuer'];
  if (
    typeof tokenEndpoint !== 'string' ||
    typeof jwksUri !== 'string' ||
    declaredIssuer !== base
  ) {
    return null;
  }
  return { tokenEndpoint, jwksUri };
}

async function importJwk(key: JwkKey, alg: string): Promise<CryptoKey | null> {
  try {
    if (alg === 'RS256' && key.kty === 'RSA') {
      return await crypto.subtle.importKey(
        'jwk',
        key as JsonWebKey,
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false,
        ['verify'],
      );
    }
    if (alg === 'ES256' && key.kty === 'EC') {
      return await crypto.subtle.importKey(
        'jwk',
        key as JsonWebKey,
        { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['verify'],
      );
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Exchanges the PKCE proof at the issuer token endpoint and verifies the
 * resulting id_token. Returns the verified `sub`, or null when any check
 * fails — callers map null to `invalid-proof` (401).
 */
export async function verifyOidcPkceProof(
  proof: OidcPkceProof,
  config: OidcAuthorityConfig,
  fetchFn: typeof fetch = fetch,
): Promise<string | null> {
  const issuer = trimTrailingSlashes(config.issuer);
  if (trimTrailingSlashes(proof.issuer) !== issuer) {
    return null;
  }
  const workosAuthKit = isWorkosAuthKitIssuer(issuer);
  const metadata = workosAuthKit ? null : await fetchOidcMetadata(issuer, fetchFn);
  const tokenEndpoint = workosAuthKit ? `${issuer}/authenticate` : metadata?.tokenEndpoint;
  if (tokenEndpoint === undefined) return null;

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: proof.authorizationCode,
    redirect_uri: proof.redirectUri,
    client_id: config.clientId,
    code_verifier: proof.codeVerifier,
  });
  const tokenResponse = await fetchJson(tokenEndpoint, fetchFn, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const idToken = tokenResponse?.['id_token'];
  if (idToken === undefined && workosAuthKit) {
    const user = tokenResponse?.['user'];
    const sub = isRecord(user) ? user['id'] : undefined;
    return typeof sub === 'string' && /^user_[A-Za-z0-9_-]{1,240}$/.test(sub) ? sub : null;
  }
  if (typeof idToken !== 'string') {
    return null;
  }

  const parts = idToken.split('.');
  if (parts.length !== 3) {
    return null;
  }
  const header = decodeJson(parts[0] ?? '');
  const claims = decodeJson(parts[1] ?? '');
  if (header === null || claims === null) {
    return null;
  }
  const alg = header['alg'];
  if (alg !== 'RS256' && alg !== 'ES256') {
    return null;
  }

  if (metadata === null) return null;
  const jwks = await fetchJson(metadata.jwksUri, fetchFn);
  const keys = jwks?.['keys'];
  if (!Array.isArray(keys)) {
    return null;
  }
  const kid = header['kid'];
  const candidates = (keys as unknown[]).filter(
    (key): key is JwkKey =>
      isRecord(key) &&
      typeof key['kty'] === 'string' &&
      (kid === undefined || key['kid'] === kid) &&
      (key['use'] === undefined || key['use'] === 'sig'),
  );
  const signature = base64UrlDecode(parts[2] ?? '');
  const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  let verified = false;
  for (const jwk of candidates) {
    const cryptoKey = await importJwk(jwk, alg);
    if (cryptoKey === null) {
      continue;
    }
    const algorithm =
      alg === 'RS256' ? { name: 'RSASSA-PKCS1-v1_5' } : { name: 'ECDSA', hash: 'SHA-256' };
    try {
      if (await crypto.subtle.verify(algorithm, cryptoKey, signature, signed)) {
        verified = true;
        break;
      }
    } catch {
      // Try the next candidate key.
    }
  }
  if (!verified) {
    return null;
  }

  const sub = claims['sub'];
  const aud = claims['aud'];
  const exp = claims['exp'];
  const nonce = claims['nonce'];
  const audOk =
    typeof aud === 'string' ? aud === config.clientId : Array.isArray(aud) && aud.includes(config.clientId);
  if (
    claims['iss'] !== issuer ||
    typeof sub !== 'string' ||
    sub.length === 0 ||
    !audOk ||
    typeof exp !== 'number' ||
    exp * 1000 <= Date.now() ||
    nonce !== proof.nonce
  ) {
    return null;
  }
  return sub;
}

/**
 * Result of one WorkOS Device Authorization token exchange. The caller owns
 * polling cadence; the backend intentionally performs one bounded provider
 * request per `/enroll` call so provider tokens never cross the Anvil client
 * boundary. The client carries only the opaque device code proof.
 */
export type WorkosDeviceProofResult =
  | { status: 'success'; subject: string }
  | { status: 'pending' }
  | { status: 'slow-down' }
  | { status: 'denied' }
  | { status: 'expired' }
  | { status: 'invalid' };

/** WorkOS device codes are opaque printable ASCII values; cap input before hashing or forwarding. */
export const WORKOS_DEVICE_CODE_MAX_LENGTH = 4096;

export function isValidWorkosDeviceCode(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > WORKOS_DEVICE_CODE_MAX_LENGTH) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code > 0x7e) return false;
  }
  return true;
}

const WORKOS_DEVICE_REQUEST_TIMEOUT_MS = 10_000;

/** Reads a provider response without allowing an unbounded body. */
async function readBoundedJson(
  response: Response,
  maxBytes: number,
): Promise<Record<string, unknown> | null> {
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  if (response.body === null) return null;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    const parsed: unknown = JSON.parse(chunks.join(''));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Makes a provider request with a bounded wall-clock timeout, including body parsing. */
async function fetchWorkosJson(
  url: string,
  fetchFn: typeof fetch,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ response: Response; payload: Record<string, unknown> | null } | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchFn(url, { ...init, signal: controller.signal });
    return { response, payload: await readBoundedJson(response, 64 * 1024) };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Exchanges a WorkOS AuthKit device code. AuthKit's User Management API
 * returns a trusted `user` object instead of an OIDC ID token; only its
 * provider-returned `user.id` is accepted, and access/refresh/ID tokens are
 * deliberately ignored. Upstream OAuth error names are normalized into a
 * stable Anvil result for the headless client.
 */
export async function verifyWorkosDeviceProof(
  proof: WorkosDeviceProof,
  config: OidcAuthorityConfig,
  fetchFn: typeof fetch = fetch,
): Promise<WorkosDeviceProofResult> {
  if (
    !isRecord(proof) ||
    !isRecord(config) ||
    typeof config.issuer !== 'string' ||
    typeof config.clientId !== 'string' ||
    typeof proof.issuer !== 'string' ||
    !isValidWorkosDeviceCode(proof.deviceCode)
  ) {
    return { status: 'invalid' };
  }
  const issuer = trimTrailingSlashes(config.issuer);
  if (
    !isWorkosAuthKitIssuer(issuer) ||
    trimTrailingSlashes(proof.issuer) !== issuer ||
    config.clientId.length === 0
  ) {
    return { status: 'invalid' };
  }

  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    device_code: proof.deviceCode,
    client_id: config.clientId,
  });
  const exchanged = await fetchWorkosJson(
    `${issuer}/authenticate`,
    fetchFn,
    {
      method: 'POST',
      // Workerd accepts only follow/manual here; manual prevents a provider
      // redirect from being followed across the authentication boundary.
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    },
    WORKOS_DEVICE_REQUEST_TIMEOUT_MS,
  );
  if (
    exchanged === null ||
    (exchanged.response.status >= 300 && exchanged.response.status < 400) ||
    exchanged.payload === null
  ) {
    return { status: 'invalid' };
  }
  const { response, payload } = exchanged;

  if (!response.ok) {
    const code = payload?.['error'];
    switch (code) {
      case 'authorization_pending':
        return { status: 'pending' };
      case 'slow_down':
        return { status: 'slow-down' };
      case 'access_denied':
        return { status: 'denied' };
      case 'expired_token':
        return { status: 'expired' };
      default:
        return { status: 'invalid' };
    }
  }

  const user = payload?.['user'];
  const subject = isRecord(user) ? user['id'] : undefined;
  return typeof subject === 'string' && /^user_[A-Za-z0-9_-]{1,240}$/.test(subject)
    ? { status: 'success', subject }
    : { status: 'invalid' };
}
