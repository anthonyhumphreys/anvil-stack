import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type { DeviceSession, EnrollmentCodeIssueResult, OidcPkceProof } from '../../contract/auth';
import { recoveryRequestBindingBytes } from '../../contract/device-security';
import { canonicalizeJson } from '../../contract/sync';
import { encodeBase64Url } from '../src/device-security';
import { sha256Hex } from '../src/hash';
import type { SessionCoordinator } from '../src/session-coordinator';
import { expectSuccess, postRpc, withSelfHostedBackend } from './helpers';

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
  identityPub: string | null;
  identityBoundAt: string | null;
};

type SecurityView = {
  generation: number;
  policy: string;
  newDeviceTrustPolicy: string;
  recoveryInvalidated: boolean;
  enrollments: EnrollmentView[];
};

type DeviceIdentityChallenge = {
  challengeId: string;
  challenge: string;
  accountId: string;
  enrollmentId: string;
  identityPub: string;
  serverPublicKey: string;
  expiresAt: string;
};

type DeviceIdentityKeyPair = {
  identityPub: string;
  privateKey: CryptoKey;
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

async function deviceIdentityKeyPair(): Promise<DeviceIdentityKeyPair> {
  const pair = (await crypto.subtle.generateKey({ name: 'X25519' }, true, [
    'deriveBits',
  ])) as CryptoKeyPair;
  return {
    identityPub: standardBase64(
      new Uint8Array((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer),
    ),
    privateKey: pair.privateKey,
  };
}

async function deviceIdentityProof(
  challenge: DeviceIdentityChallenge,
  identity: DeviceIdentityKeyPair,
): Promise<string> {
  const serverPublicBytes = decodeBase64UrlForTest(challenge.serverPublicKey);
  const challengeBytes = decodeBase64UrlForTest(challenge.challenge);
  const serverPublicKey = await crypto.subtle.importKey(
    'raw',
    serverPublicBytes,
    { name: 'X25519' },
    false,
    [],
  );
  const deriveAlgorithm = {
    name: 'X25519',
    public: serverPublicKey,
  } as unknown as SubtleCryptoDeriveKeyAlgorithm;
  const sharedSecret = await crypto.subtle.deriveBits(deriveAlgorithm, identity.privateKey, 256);
  const hkdfKey = await crypto.subtle.importKey('raw', sharedSecret, 'HKDF', false, ['deriveKey']);
  const hmacKey = await crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: challengeBytes,
      info: new TextEncoder().encode('anvil-device-identity-binding-v1'),
    },
    hkdfKey,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign'],
  );
  const message = new TextEncoder().encode(
    canonicalizeJson({
      action: 'bind-device-identity',
      accountId: challenge.accountId,
      challenge: challenge.challenge,
      challengeId: challenge.challengeId,
      enrollmentId: challenge.enrollmentId,
      identityPub: challenge.identityPub,
      serverPublicKey: challenge.serverPublicKey,
      v: 1,
    }),
  );
  return encodeBase64Url(new Uint8Array(await crypto.subtle.sign('HMAC', hmacKey, message)));
}

function decodeBase64UrlForTest(value: string): Uint8Array {
  const padded =
    value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function encodeBase64UrlForTest(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function identityChallenge(
  session: DeviceSession,
  identityPub: string,
): Promise<DeviceIdentityChallenge> {
  return expectSuccess<DeviceIdentityChallenge>(
    await postRpc('security.identityChallenge', { identityPub }, bearer(session)),
  );
}

async function bindIdentity(
  session: DeviceSession,
  challenge: DeviceIdentityChallenge,
  identity: DeviceIdentityKeyPair,
  proof?: string,
) {
  const proofValue = proof ?? (await deviceIdentityProof(challenge, identity));
  return postRpc(
    'security.bindIdentity',
    { challengeId: challenge.challengeId, identityPub: identity.identityPub, proof: proofValue },
    bearer(session),
  );
}

async function issueEnrollmentCode(
  accountId: string,
  options: Record<string, unknown> = {},
): Promise<EnrollmentCodeIssueResult> {
  env.ENROLLMENT_ADMIN_TOKEN = 'identity-binding-test-admin';
  const response = await withSelfHostedBackend(() =>
    SELF.fetch('https://spike.test/v1/enrollment-codes', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer identity-binding-test-admin',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ accountId, ...options }),
    }),
  );
  expect(response.status).toBe(200);
  return (await response.json()) as EnrollmentCodeIssueResult;
}

async function enrollCode(code: string, installationId: string): Promise<DeviceSession> {
  const response = await withSelfHostedBackend(() =>
    SELF.fetch('https://spike.test/v1/enroll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ proof: { method: 'enrollment-code', code }, installationId }),
    }),
  );
  expect(response.status).toBe(200);
  return (await response.json()) as DeviceSession;
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

  it('binds trusted durable OIDC identities once with an enrollment-bound X25519 proof', async () => {
    const authority = await makeOidcAuthority();
    env.OIDC_ISSUER = ISSUER;
    env.OIDC_CLIENT_ID = CLIENT_ID;
    const subject = `identity-binding-${crypto.randomUUID()}`;
    const first = await enrollOidc(authority, authority.issue(subject), 'identity-first');
    const pending = await enrollOidc(authority, authority.issue(subject), 'identity-pending');
    const identity = await deviceIdentityKeyPair();

    expect(
      (
        await postRpc(
          'security.identityChallenge',
          { identityPub: identity.identityPub },
          bearer(pending),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await postRpc(
          'security.identityChallenge',
          { identityPub: encodeBase64UrlForTest(decodeBase64UrlForTest(identity.identityPub)) },
          bearer(first),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await postRpc(
          'security.identityChallenge',
          { identityPub: standardBase64(new Uint8Array(32)) },
          bearer(first),
        )
      ).status,
    ).toBe(400);

    const challenge = await identityChallenge(first, identity.identityPub);
    expect(challenge).toMatchObject({
      accountId: first.accountId,
      enrollmentId: first.enrollmentId,
      identityPub: identity.identityPub,
      serverPublicKey: expect.any(String),
      challenge: expect.any(String),
    });
    const proof = await deviceIdentityProof(challenge, identity);
    const bound = expectSuccess<{
      accountId: string;
      enrollmentId: string;
      identityPub: string;
      identityBoundAt: string;
    }>(await bindIdentity(first, challenge, identity, proof));
    expect(bound).toMatchObject({
      accountId: first.accountId,
      enrollmentId: first.enrollmentId,
      identityPub: identity.identityPub,
    });
    expect(Number.isNaN(Date.parse(bound.identityBoundAt))).toBe(false);

    const view = await securityView(first);
    expect(view).toMatchObject({
      policy: 'require-approval',
      newDeviceTrustPolicy: 'require-approval',
      enrollments: expect.arrayContaining([
        expect.objectContaining({
          enrollmentId: first.enrollmentId,
          proofMethod: 'oidc-pkce',
          enrollmentClass: 'device',
          trustState: 'trusted',
          trustSource: 'first-device',
          identityPub: identity.identityPub,
          identityBoundAt: bound.identityBoundAt,
        }),
      ]),
    });
    const roster = expectSuccess<{ devices: Array<Record<string, unknown>> }>(
      await postRpc('device.list', {}, bearer(first)),
    );
    expect(roster.devices).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          enrollmentId: first.enrollmentId,
          proofMethod: 'oidc-pkce',
          identityPub: identity.identityPub,
          identityBoundAt: bound.identityBoundAt,
        }),
      ]),
    );

    const rebindKey = await deviceIdentityKeyPair();
    expect(
      (
        await postRpc(
          'security.identityChallenge',
          { identityPub: rebindKey.identityPub },
          bearer(first),
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await postRpc(
          'security.bindIdentity',
          { challengeId: challenge.challengeId, identityPub: identity.identityPub, proof },
          bearer(first),
        )
      ).status,
    ).toBe(409);
  });

  it('binds trusted provider devices and rejects pending, code, duplicate-key, invalid-proof, and replay bindings', async () => {
    const authority = await makeOidcAuthority();
    env.OIDC_ISSUER = ISSUER;
    env.OIDC_CLIENT_ID = CLIENT_ID;
    const subject = `identity-eligibility-${crypto.randomUUID()}`;
    const first = await enrollOidc(authority, authority.issue(subject), 'eligibility-first');
    const manual = await enrollOidc(authority, authority.issue(subject), 'eligibility-manual');
    const rootIdentity = await deviceIdentityKeyPair();
    const rootChallenge = await identityChallenge(first, rootIdentity.identityPub);
    const rootProof = await deviceIdentityProof(rootChallenge, rootIdentity);
    expectSuccess(await bindIdentity(first, rootChallenge, rootIdentity, rootProof));

    const manualIdentity = await deviceIdentityKeyPair();
    expect(
      (
        await postRpc(
          'security.identityChallenge',
          { identityPub: manualIdentity.identityPub },
          bearer(manual),
        )
      ).status,
    ).toBe(403);
    const manualApproval = await postRpc(
      'security.approve',
      { enrollmentId: manual.enrollmentId, source: 'manual-approval' },
      bearer(first),
    );
    expect(manualApproval.status).toBe(200);
    const manualChallenge = await identityChallenge(manual, manualIdentity.identityPub);
    const manualProof = await deviceIdentityProof(manualChallenge, manualIdentity);
    expectSuccess(await bindIdentity(manual, manualChallenge, manualIdentity, manualProof));

    const recovery = await ed25519Material();
    expectSuccess<SecurityView>(
      await postRpc(
        'security.configure',
        {
          policy: 'auto-trust-authenticated',
          backendId: `identity-backend-${crypto.randomUUID()}`,
          envelope: recoveryEnvelope(recovery.publicKey),
        },
        bearer(first),
      ),
    );
    const automatic = await enrollOidc(authority, authority.issue(subject), 'eligibility-auto');
    const duplicateKeyChallenge = await postRpc(
      'security.identityChallenge',
      { identityPub: rootIdentity.identityPub },
      bearer(automatic),
    );
    expect(duplicateKeyChallenge.status).toBe(409);

    const automaticIdentity = await deviceIdentityKeyPair();
    const automaticChallenge = await identityChallenge(automatic, automaticIdentity.identityPub);
    const invalidProof = encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
    expect(
      (await bindIdentity(automatic, automaticChallenge, automaticIdentity, invalidProof)).status,
    ).toBe(401);
    expect(
      (
        await postRpc(
          'security.bindIdentity',
          {
            challengeId: automaticChallenge.challengeId,
            identityPub: automaticIdentity.identityPub,
            proof: await deviceIdentityProof(automaticChallenge, automaticIdentity),
          },
          bearer(first),
        )
      ).status,
    ).toBe(409);

    const acceptedProof = await deviceIdentityProof(automaticChallenge, automaticIdentity);
    expectSuccess(
      await bindIdentity(automatic, automaticChallenge, automaticIdentity, acceptedProof),
    );
    expect(
      (
        await postRpc(
          'security.bindIdentity',
          {
            challengeId: automaticChallenge.challengeId,
            identityPub: automaticIdentity.identityPub,
            proof: acceptedProof,
          },
          bearer(automatic),
        )
      ).status,
    ).toBe(409);

    expect(
      (await postRpc('device.revoke', { enrollmentId: automatic.enrollmentId }, bearer(first)))
        .status,
    ).toBe(200);
    expect(
      (
        await postRpc(
          'security.identityChallenge',
          { identityPub: (await deviceIdentityKeyPair()).identityPub },
          bearer(automatic),
        )
      ).status,
    ).toBe(401);

    const codeAccount = `acct-identity-code-${crypto.randomUUID()}`;
    const code = await issueEnrollmentCode(codeAccount);
    const codeEnrollment = await enrollCode(code.code, 'identity-code-enrollment');
    expect(
      (
        await postRpc(
          'security.identityChallenge',
          { identityPub: (await deviceIdentityKeyPair()).identityPub },
          bearer(codeEnrollment),
        )
      ).status,
    ).toBe(403);

    const ephemeralCode = await issueEnrollmentCode(`acct-identity-env-${crypto.randomUUID()}`, {
      enrollmentClass: 'ephemeral',
      provider: 'test',
      sessionTtlSeconds: 300,
      environmentId: `env-${crypto.randomUUID()}`,
    });
    const ephemeral = await enrollCode(ephemeralCode.code, 'identity-ephemeral-enrollment');
    expect(
      (
        await postRpc(
          'security.identityChallenge',
          { identityPub: (await deviceIdentityKeyPair()).identityPub },
          bearer(ephemeral),
        )
      ).status,
    ).toBe(401);
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
