import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  authErrorHttpStatus,
  base64UrlEncode,
  buildLoopbackRedirectUri,
  createPkceS256Pair,
  isAllowedOidcRedirectUri,
  OIDC_MAX_PORT,
  OIDC_MIN_PORT,
} from '../auth';

function sha256Bytes(data: Uint8Array): Uint8Array {
  return new Uint8Array(createHash('sha256').update(data).digest());
}

describe('base64UrlEncode', () => {
  it('encodes RFC-style vectors without padding', () => {
    expect(base64UrlEncode(new Uint8Array([]))).toBe('');
    expect(base64UrlEncode(new Uint8Array([0x66]))).toBe('Zg');
    expect(base64UrlEncode(new Uint8Array([0x66, 0x6f]))).toBe('Zm8');
    expect(base64UrlEncode(new Uint8Array([0x66, 0x6f, 0x6f]))).toBe('Zm9v');
  });

  it('uses the url-safe alphabet', () => {
    // 0xFB 0xFF is '+/8=' in standard base64, '-_8' in base64url.
    expect(base64UrlEncode(new Uint8Array([0xfb, 0xff]))).toBe('-_8');
    expect(base64UrlEncode(new Uint8Array([0xff, 0xff]))).toBe('__8');
  });
});

describe('createPkceS256Pair', () => {
  it('returns an S256 challenge computed independently with node:crypto', () => {
    const random = new Uint8Array(Array.from({ length: 32 }, (_, i) => i));
    const pair = createPkceS256Pair(random, sha256Bytes);

    expect(pair.method).toBe('S256');
    const expectedVerifier = Buffer.from(random).toString('base64url');
    expect(pair.verifier).toBe(expectedVerifier);

    const expectedChallenge = createHash('sha256').update(pair.verifier, 'utf8').digest('base64url');
    expect(pair.challenge).toBe(expectedChallenge);
    expect(pair.challenge).toBe(base64UrlEncode(sha256Bytes(Buffer.from(pair.verifier, 'utf8'))));
  });

  it('rejects randomness that is not exactly 32 bytes', () => {
    expect(() => createPkceS256Pair(new Uint8Array(31), sha256Bytes)).toThrow(/32 bytes/);
    expect(() => createPkceS256Pair(new Uint8Array(33), sha256Bytes)).toThrow(/32 bytes/);
  });
});

describe('buildLoopbackRedirectUri', () => {
  it('builds the frozen callback form for ephemeral ports', () => {
    expect(buildLoopbackRedirectUri(49152)).toBe('http://127.0.0.1:49152/callback');
    expect(buildLoopbackRedirectUri(65535)).toBe('http://127.0.0.1:65535/callback');
  });

  it('rejects ports outside 49152-65535', () => {
    expect(() => buildLoopbackRedirectUri(49151)).toThrow();
    expect(() => buildLoopbackRedirectUri(65536)).toThrow();
    expect(() => buildLoopbackRedirectUri(443)).toThrow();
  });
});

describe('isAllowedOidcRedirectUri', () => {
  it('accepts loopback callbacks with ephemeral ports', () => {
    expect(isAllowedOidcRedirectUri('http://127.0.0.1:49152/callback')).toBe(true);
    expect(isAllowedOidcRedirectUri('http://127.0.0.1:54321/callback')).toBe(true);
    expect(isAllowedOidcRedirectUri(`http://127.0.0.1:${OIDC_MAX_PORT}/callback`)).toBe(true);
    expect(isAllowedOidcRedirectUri(`http://127.0.0.1:${OIDC_MIN_PORT}/callback`)).toBe(true);
  });

  it('rejects non-loopback hosts, schemes, and userinfo', () => {
    expect(isAllowedOidcRedirectUri('https://127.0.0.1:54321/callback')).toBe(false);
    expect(isAllowedOidcRedirectUri('http://localhost:54321/callback')).toBe(false);
    expect(isAllowedOidcRedirectUri('http://0.0.0.0:54321/callback')).toBe(false);
    expect(isAllowedOidcRedirectUri('http://127.0.0.2:54321/callback')).toBe(false);
    expect(isAllowedOidcRedirectUri('http://user:pass@127.0.0.1:54321/callback')).toBe(false);
    expect(isAllowedOidcRedirectUri('http://user@127.0.0.1:54321/callback')).toBe(false);
  });

  it('rejects ports outside the ephemeral range', () => {
    expect(isAllowedOidcRedirectUri('http://127.0.0.1:8080/callback')).toBe(false);
    expect(isAllowedOidcRedirectUri('http://127.0.0.1:443/callback')).toBe(false);
    expect(isAllowedOidcRedirectUri('http://127.0.0.1:49151/callback')).toBe(false);
    expect(isAllowedOidcRedirectUri('http://127.0.0.1:65536/callback')).toBe(false);
    expect(isAllowedOidcRedirectUri('http://127.0.0.1/callback')).toBe(false);
  });

  it('rejects extra path segments, queries, and fragments that could leak the code', () => {
    expect(isAllowedOidcRedirectUri('http://127.0.0.1:54321/callback/extra')).toBe(false);
    expect(isAllowedOidcRedirectUri('http://127.0.0.1:54321/callback/')).toBe(false);
    expect(isAllowedOidcRedirectUri('http://127.0.0.1:54321/callback?code=abc')).toBe(false);
    expect(isAllowedOidcRedirectUri('http://127.0.0.1:54321/callback#fragment')).toBe(false);
    expect(isAllowedOidcRedirectUri('http://127.0.0.1:54321/other')).toBe(false);
    expect(isAllowedOidcRedirectUri('not a uri')).toBe(false);
    expect(isAllowedOidcRedirectUri('')).toBe(false);
  });
});

describe('authErrorHttpStatus', () => {
  it('maps every auth failure to HTTP 401', () => {
    expect(authErrorHttpStatus('refresh-reuse-detected')).toBe(401);
    expect(authErrorHttpStatus('enrollment-code-used')).toBe(401);
    expect(authErrorHttpStatus('invalid-proof')).toBe(401);
  });
});
