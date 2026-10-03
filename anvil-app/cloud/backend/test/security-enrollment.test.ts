import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type { DeviceSession, OidcPkceProof } from '../../contract/auth';
import { recoveryRequestBindingBytes } from '../../contract/device-security';
import { canonicalizeJson } from '../../contract/sync';
import { encodeBase64Url } from '../src/device-security';
import { sha256Hex } from '../src/hash';
import type { SessionCoordinator } from '../src/session-coordinator';
import { expectSuccess, postRpc } from './helpers';

const ISSUER = 'https://issuer.test';
const CLIENT_ID = 'anvil-test-client';
const REDIRECT_URI = 'http://127.0.0.1:50000/callback';

type OidcGrant = {
  redirectUri: string;
  verifier: string;
  nonce: string;
  sub: string;
};

type OidcAuthority = {
  issue(sub: string): OidcPkceProof;
  fetchFn: typeof fetch;
};

type EnrollmentView = {
  enrollmentId: string;
  proofMethod: string;
  trustState: string;
  trustSource: string;
};

type SecurityView = {
  generation: number;
  policy: string;
  recoveryInvalidated: boolean;
  enrollments: EnrollmentView[];
};

async function makeOidcAuthority(): Promise<OidcAuthority> {
  const keyPair = (await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const publicJwk = (await crypto.subtle.exportKey('jwk', keyPair.publicKey)) as JsonWebKey & {
    kid?: string;
    use?: string;
    alg?: string;
  };
  publicJwk.kid = 'security-enrollment-test-key';
  publicJwk.use = 'sig';
  publicJwk.alg = 'RS256';
  const grants = new Map<string, OidcGrant>();

  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url === `${ISSUER}/.well-known/openid-configuration`) {
      return Response.json({
        issuer: ISSUER,
        token_endpoint: `${ISSUER}/token`,
        jwks_uri: `${ISSUER}/jwks.json`,
      });
    }
    if (url === `${ISSUER}/jwks.json`) {
      return Response.json({ keys: [publicJwk] });
    }
    if (url === `${ISSUER}/token`) {
      const params = new URLSearchParams(init?.body as string);
      const code = params.get('code') ?? '';
      const grant = grants.get(code);
      if (
        grant === undefined ||
        params.get('code_verifier') !== grant.verifier ||
        params.get('redirect_uri') !== grant.redirectUri ||
        params.get('client_id') !== CLIENT_ID ||
        params.get('grant_type') !== 'authorization_code'
      ) {
        return Response.json({ error: 'invalid_grant' }, { status: 400 });
      }
      grants.delete(code);
      const header = base64Url(JSON.stringify({ alg: 'RS256', kid: publicJwk.kid }));
      const claims = base64Url(
        JSON.stringify({
          iss: ISSUER,
          sub: grant.sub,
          aud: CLIENT_ID,
          exp: Math.floor(Date.now() / 1000) + 300,
          nonce: grant.nonce,
        }),
      );
      const signature = await crypto.subtle.sign(
        { name: 'RSASSA-PKCS1-v1_5' },
        keyPair.privateKey,
        new TextEncoder().encode(`${header}.${claims}`),
      );
      return Response.json({
        id_token: `${header}.${claims}.${base64UrlBytes(new Uint8Array(signature))}`,
        access_token: 'test-access-token',
        token_type: 'Bearer',
      });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;

  return {
    fetchFn,
    issue(sub: string): OidcPkceProof {
      const code = `oidc-code-${crypto.randomUUID()}`;
      const grant = {
        redirectUri: REDIRECT_URI,
        verifier: `verifier-${crypto.randomUUID()}`,
        nonce: `nonce-${crypto.randomUUID()}`,
        sub,
      };
      grants.set(code, grant);
      return {
        method: 'oidc-pkce',
        issuer: ISSUER,
        authorizationCode: code,
        codeVerifier: grant.verifier,
        redirectUri: grant.redirectUri,
        nonce: grant.nonce,
      };
    },
  };
}

function base64Url(text: string): string {
  return base64UrlBytes(new TextEncoder().encode(text));
}

function base64UrlBytes(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function enrollOidc(
  authority: OidcAuthority,
  proof: OidcPkceProof,
  installationId: string,
): Promise<DeviceSession> {
  const stub = env.SESSIONS.get(env.SESSIONS.idFromName('sessions'));
  const result = await runInDurableObject(stub, async (instance: SessionCoordinator) => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = authority.fetchFn;
    try {
      const response = await instance.fetch(
        new Request('https://internal.anvil/enroll', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ proof, installationId, displayName: 'OIDC security test' }),
        }),
      );
      return { status: response.status, body: await response.json() };
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
  expect(result.status).toBe(200);
  return result.body as DeviceSession;
}

function bearer(session: DeviceSession): string {
  return `Bearer ${session.accessToken}`;
}

async function securityView(session: DeviceSession): Promise<SecurityView> {
  return expectSuccess<SecurityView>(await postRpc('security.get', {}, bearer(session)));
}

function standardBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function ed25519Material(): Promise<{
  publicKey: string;
  sign: (message: Uint8Array) => Promise<string>;
}> {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const publicRaw = (await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer;
  return {
    publicKey: encodeBase64Url(new Uint8Array(publicRaw)),
    sign: async (message) =>
      encodeBase64Url(
        new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, pair.privateKey, message)),
      ),
  };
}

function recoveryEnvelope(publicKey: string) {
  return {
    v: 1,
    algorithm: 'aes-256-gcm',
    recoveryId: crypto.randomUUID(),
    publicKey,
    nonce: standardBase64(crypto.getRandomValues(new Uint8Array(12))),
    ct: standardBase64(crypto.getRandomValues(new Uint8Array(32))),
  } as const;
}

async function payloadHash(payload: unknown): Promise<string> {
  return sha256Hex(canonicalizeJson(payload));
}

async function signedProof(
  session: DeviceSession,
  action: 'recover',
  material: Awaited<ReturnType<typeof ed25519Material>>,
  binding: { payloadHash: string; backendId: string; identityPub: string },
) {
  const challenge = expectSuccess<{
    challengeId: string;
    challenge: string;
    accountId: string;
    enrollmentId: string;
    action: string;
    accountRevision: number;
    recoveryId: string;
    backendId: string;
    identityPub: string;
    payloadHash: string;
  }>(
    await postRpc(
      'security.challenge',
      { action, payloadHash: binding.payloadHash, backendId: binding.backendId, identityPub: binding.identityPub },
      bearer(session),
    ),
  );
  const message = recoveryRequestBindingBytes({
    action: challenge.action,
    accountId: challenge.accountId,
    backendId: challenge.backendId,
    enrollmentId: challenge.enrollmentId,
    identityPub: challenge.identityPub,
    recoveryId: challenge.recoveryId,
    revision: challenge.accountRevision,
    challenge: challenge.challenge,
    payloadHash: challenge.payloadHash,
  });
  return {
    challengeId: challenge.challengeId,
    identityPub: challenge.identityPub,
    payloadHash: challenge.payloadHash,
    signature: await material.sign(message),
  };
}

async function refresh(session: DeviceSession): Promise<Response> {
  return SELF.fetch('https://spike.test/v1/session/refresh', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refreshToken: session.refreshToken, enrollmentId: session.enrollmentId }),
  });
}

describe('OIDC enrollment trust policy', () => {
  it('keeps manual OIDC enrollment pending and never retro-trusts it after opting in', async () => {
    const authority = await makeOidcAuthority();
    env.OIDC_ISSUER = ISSUER;
    env.OIDC_CLIENT_ID = CLIENT_ID;
    const subject = `manual-${crypto.randomUUID()}`;
    const first = await enrollOidc(authority, authority.issue(subject), 'oidc-manual-first');
    const pending = await enrollOidc(authority, authority.issue(subject), 'oidc-manual-second');

    expect((await securityView(first)).enrollments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          enrollmentId: pending.enrollmentId,
          proofMethod: 'oidc-pkce',
          trustState: 'pending',
          trustSource: 'unknown',
        }),
      ]),
    );

    const material = await ed25519Material();
    const configured = expectSuccess<SecurityView>(
      await postRpc(
        'security.configure',
        {
          policy: 'auto-trust-authenticated',
          backendId: `backend-${crypto.randomUUID()}`,
          envelope: recoveryEnvelope(material.publicKey),
        },
        bearer(first),
      ),
    );
    expect(configured.policy).toBe('auto-trust-authenticated');
    expect(configured.enrollments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ enrollmentId: pending.enrollmentId, trustState: 'pending' }),
      ]),
    );

    const automatic = await enrollOidc(authority, authority.issue(subject), 'oidc-auto-third');
    const after = await securityView(first);
    expect(after.enrollments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          enrollmentId: automatic.enrollmentId,
          proofMethod: 'oidc-pkce',
          trustState: 'trusted',
          trustSource: 'automatic-auth',
        }),
        expect.objectContaining({ enrollmentId: pending.enrollmentId, trustState: 'pending' }),
      ]),
    );
  });

  it('revokes old OIDC credentials, fences old recovery maintenance, and advances auto trust generation', async () => {
    const authority = await makeOidcAuthority();
    env.OIDC_ISSUER = ISSUER;
    env.OIDC_CLIENT_ID = CLIENT_ID;
    const subject = `revocation-${crypto.randomUUID()}`;
    const root = await enrollOidc(authority, authority.issue(subject), 'oidc-root');
    const material = await ed25519Material();
    const backendId = `backend-${crypto.randomUUID()}`;
    const envelope = recoveryEnvelope(material.publicKey);
    expectSuccess<SecurityView>(
      await postRpc(
        'security.configure',
        { policy: 'auto-trust-authenticated', backendId, envelope },
        bearer(root),
      ),
    );
    const automatic = await enrollOidc(authority, authority.issue(subject), 'oidc-automatic');
    const beforeRevoke = await securityView(automatic);
    expect(beforeRevoke.enrollments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          enrollmentId: automatic.enrollmentId,
          trustState: 'trusted',
          trustSource: 'automatic-auth',
        }),
      ]),
    );

    // A trusted, automatically enrolled device can still complete a fresh
    // recovery proof while the recovery root is valid. The proof is one-use;
    // obtaining a second challenge permits a second deliberate recovery.
    const recoveryPayloadHash = await payloadHash({});
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const proof = await signedProof(automatic, 'recover', material, {
        payloadHash: recoveryPayloadHash,
        backendId,
        identityPub: encodeBase64Url(crypto.getRandomValues(new Uint8Array(32))),
      });
      expectSuccess<{ recovered: boolean }>(
        await postRpc(
          'security.recover',
          { payloadHash: recoveryPayloadHash, proof },
          bearer(automatic),
        ),
      ).recovered;
    }

    expect(
      (await postRpc('device.revoke', { enrollmentId: root.enrollmentId }, bearer(automatic))).status,
    ).toBe(200);
    const afterRevoke = await securityView(automatic);
    expect(afterRevoke.recoveryInvalidated).toBe(true);
    expect(afterRevoke.generation).toBeGreaterThan(beforeRevoke.generation);
    expect(afterRevoke.enrollments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ enrollmentId: root.enrollmentId, trustState: 'revoked' }),
      ]),
    );

    expect((await postRpc('security.get', {}, bearer(root))).status).toBe(401);
    expect((await refresh(root)).status).toBe(401);
    expect((await postRpc('security.recover', {}, bearer(root))).status).toBe(401);
    expect((await postRpc('security.updateRecovery', {}, bearer(root))).status).toBe(401);
    expect((await postRpc('security.setPolicy', {}, bearer(root))).status).toBe(401);

    const fresh = await enrollOidc(authority, authority.issue(subject), 'oidc-fresh-after-revoke');
    const final = await securityView(fresh);
    expect(final.generation).toBe(afterRevoke.generation);
    expect(final.enrollments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          enrollmentId: fresh.enrollmentId,
          proofMethod: 'oidc-pkce',
          trustState: 'trusted',
          trustSource: 'automatic-auth',
        }),
      ]),
    );
  });
});
