// Server-side OIDC authorization-code + PKCE verification (AUTH-01).
//
// The backend exchanges the desktop's authorization code at the configured
// issuer's token endpoint, then verifies the returned id_token signature
// against the issuer JWKS plus the iss/aud/exp/nonce claims. The account
// identity is derived from the verified `sub`, never from caller input.
//
// `fetch` is injectable so tests can serve a real issuer shape (metadata,
// token endpoint, JWKS with a generated key) without live network access.

import type { OidcPkceProof } from '../../contract/auth';
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

/**
 * Discovers the issuer's token and JWKS endpoints via RFC 8414 metadata.
 * The metadata document must declare the same issuer string it was fetched
 * under, so a mismatched authority cannot redirect proof verification.
 */
async function fetchOidcMetadata(
  issuer: string,
  fetchFn: typeof fetch,
): Promise<OidcMetadata | null> {
  const base = issuer.replace(/\/+$/, '');
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
  const issuer = config.issuer.replace(/\/+$/, '');
  if (proof.issuer.replace(/\/+$/, '') !== issuer) {
    return null;
  }
  const metadata = await fetchOidcMetadata(issuer, fetchFn);
  if (metadata === null) {
    return null;
  }

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: proof.authorizationCode,
    redirect_uri: proof.redirectUri,
    client_id: config.clientId,
    code_verifier: proof.codeVerifier,
  });
  const tokenResponse = await fetchJson(metadata.tokenEndpoint, fetchFn, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const idToken = tokenResponse?.['id_token'];
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
