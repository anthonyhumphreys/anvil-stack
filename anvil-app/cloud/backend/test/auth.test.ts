import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type {
  DeviceListResult,
  DeviceRenameResult,
  DeviceRevokeResult,
  DeviceSession,
  EnrollmentCodeIssueResult,
  SessionDescribeResult,
} from '../../contract/auth';
import { httpStatusForErrorCode, isRpcError } from '../../contract/envelope';
import type { SyncPullResult } from '../../contract/sync';
import { sha256Hex } from '../src/hash';
import { verifyOidcPkceProof } from '../src/oidc';
import { expectSuccess, postRpc } from './helpers';

const ADMIN_TOKEN = 'test-admin-credential';

function adminHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${ADMIN_TOKEN}` };
}

async function postAuthRoute(
  path: string,
  body: unknown,
  authorization?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await SELF.fetch(`https://spike.test${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(authorization === undefined ? {} : { Authorization: authorization }),
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function issueCode(
  accountId: string,
  authorization = `Bearer ${ADMIN_TOKEN}`,
): Promise<EnrollmentCodeIssueResult> {
  const { status, body } = await postAuthRoute('/v1/enrollment-codes', { accountId }, authorization);
  expect(status).toBe(200);
  return body as unknown as EnrollmentCodeIssueResult;
}

async function enrollWithCode(code: string, installationId = 'install-1'): Promise<DeviceSession> {
  const { status, body } = await postAuthRoute('/v1/enroll', {
    proof: { method: 'enrollment-code', code },
    installationId,
    displayName: 'Test device',
  });
  expect(status).toBe(200);
  return body as unknown as DeviceSession;
}

async function refresh(session: DeviceSession): Promise<{ status: number; body: Record<string, unknown> }> {
  return postAuthRoute('/v1/session/refresh', {
    refreshToken: session.refreshToken,
    enrollmentId: session.enrollmentId,
  });
}

function bearer(session: DeviceSession): string {
  return `Bearer ${session.accessToken}`;
}

describe('enrollment-code authentication', () => {
  it('issues a code as admin, enrolls a device, and the session reaches sync.pull', async () => {
    env.ENROLLMENT_ADMIN_TOKEN = ADMIN_TOKEN;
    const accountId = `acct-${crypto.randomUUID()}`;
    const issued = await issueCode(accountId);
    expect(issued.accountId).toBe(accountId);
    expect(issued.code.startsWith('anvil-ec-')).toBe(true);

    const session = await enrollWithCode(issued.code);
    expect(session.accountId).toBe(accountId);
    expect(session.credentialGeneration).toBe(1);
    expect(session.datasetEpoch).toBe('spike-epoch-1');

    const pull = await postRpc('sync.pull', { cursor: null, maxBytes: 16384 }, bearer(session));
    const result = expectSuccess<SyncPullResult>(pull);
    expect(result.changes).toHaveLength(0);
    expect(session.datasetEpoch).toBe('spike-epoch-1');
  });

  it('rejects consuming the same enrollment code twice', async () => {
    env.ENROLLMENT_ADMIN_TOKEN = ADMIN_TOKEN;
    const issued = await issueCode(`acct-${crypto.randomUUID()}`);
    await enrollWithCode(issued.code);
    const second = await postAuthRoute('/v1/enroll', {
      proof: { method: 'enrollment-code', code: issued.code },
      installationId: 'install-2',
    });
    expect(second.status).toBe(401);
    expect((second.body['error'] as { code: string }).code).toBe('enrollment-code-used');
  });

  it('lets a signed-in device issue a pairing code bound to its account', async () => {
    env.ENROLLMENT_ADMIN_TOKEN = ADMIN_TOKEN;
    const accountId = `acct-${crypto.randomUUID()}`;
    const first = await enrollWithCode((await issueCode(accountId)).code);
    const pairing = await issueCode('', bearer(first));
    expect(pairing.accountId).toBe(accountId);
    const second = await enrollWithCode(pairing.code, 'install-2');
    expect(second.accountId).toBe(accountId);
    expect(second.enrollmentId).not.toBe(first.enrollmentId);
  });

  it('rejects code issuance without credentials', async () => {
    const { status } = await postAuthRoute('/v1/enrollment-codes', { accountId: 'acct-x' });
    expect(status).toBe(401);
  });
});

async function freshSession(): Promise<DeviceSession> {
  env.ENROLLMENT_ADMIN_TOKEN = ADMIN_TOKEN;
  const issued = await issueCode(`acct-${crypto.randomUUID()}`);
  return enrollWithCode(issued.code);
}

describe('device session lifecycle', () => {
  it('rotates credentials on refresh and invalidates the old access token', async () => {
    const session = await freshSession();
    const rotated = await refresh(session);
    expect(rotated.status).toBe(200);
    const next = rotated.body as unknown as DeviceSession;
    expect(next.credentialGeneration).toBe(2);
    expect(next.refreshToken).not.toBe(session.refreshToken);
    expect(next.accessToken).not.toBe(session.accessToken);

    const stale = await postRpc('sync.pull', { cursor: null, maxBytes: 1024 }, bearer(session));
    expect(stale.status).toBe(httpStatusForErrorCode('unauthenticated'));
    const fresh = await postRpc('sync.pull', { cursor: null, maxBytes: 1024 }, bearer(next));
    expect(fresh.status).toBe(200);
  });

  it('replays the stored rotation when a refresh response was lost (grace window)', async () => {
    const session = await freshSession();
    const first = await refresh(session);
    expect(first.status).toBe(200);
    // Client never saw the response; it retries with the same old token.
    const replay = await refresh(session);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(first.body);
  });

  it('serializes concurrent refreshes of the same credential', async () => {
    const session = await freshSession();
    const [a, b] = await Promise.all([refresh(session), refresh(session)]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(b.body).toEqual(a.body);
  });

  it('revokes the session and rejects all subsequent tokens', async () => {
    const session = await freshSession();
    const revoked = await postAuthRoute(
      '/v1/session/revoke',
      { enrollmentId: session.enrollmentId, refreshToken: session.refreshToken },
      bearer(session),
    );
    expect(revoked.status).toBe(200);
    const after = await postRpc('sync.pull', { cursor: null, maxBytes: 1024 }, bearer(session));
    expect(after.status).toBe(httpStatusForErrorCode('unauthenticated'));
    const refreshAfter = await refresh(session);
    expect(refreshAfter.status).toBe(401);
    // Idempotent: a second revoke still reports revoked.
    const again = await postAuthRoute(
      '/v1/session/revoke',
      { enrollmentId: session.enrollmentId, refreshToken: session.refreshToken },
      bearer(session),
    );
    expect(again.status).toBe(200);
    expect((again.body as { revoked: boolean }).revoked).toBe(true);
  });

  it('rejects revocation authorized by a different enrollment', async () => {
    const session = await freshSession();
    const other = await freshSession();
    const denied = await postAuthRoute(
      '/v1/session/revoke',
      { enrollmentId: session.enrollmentId },
      bearer(other),
    );
    expect(denied.status).toBe(401);
    const stillValid = await postRpc(
      'sync.pull',
      { cursor: null, maxBytes: 1024 },
      bearer(session),
    );
    expect(stillValid.status).toBe(200);
  });

  it('session.describe returns identity and epoch without tokens', async () => {
    const session = await freshSession();
    const described = await postRpc('session.describe', {}, bearer(session));
    const result = expectSuccess<SessionDescribeResult>(described);
    expect(result.accountId).toBe(session.accountId);
    expect(result.enrollmentId).toBe(session.enrollmentId);
    expect(result.datasetEpoch).toBe('spike-epoch-1');
    expect(JSON.stringify(result)).not.toContain('anvil_at_');
    expect(JSON.stringify(result)).not.toContain('anvil_rt_');
  });
});

describe('device.* account lifecycle', () => {
  /** Two real sessions on one account: device A via admin code, device B via A's pairing code. */
  async function twoDevices(): Promise<{ a: DeviceSession; b: DeviceSession }> {
    env.ENROLLMENT_ADMIN_TOKEN = ADMIN_TOKEN;
    const accountId = `acct-${crypto.randomUUID()}`;
    const a = await enrollWithCode((await issueCode(accountId)).code, 'install-a');
    const pairing = await issueCode('', bearer(a));
    const b = await enrollWithCode(pairing.code, 'install-b');
    return { a, b };
  }

  it('device.list shows both enrollments with self marked', async () => {
    const { a, b } = await twoDevices();
    const listed = await postRpc('device.list', {}, bearer(a));
    const result = expectSuccess<DeviceListResult>(listed);
    expect(result.devices).toHaveLength(2);
    const self = result.devices.find((d) => d.enrollmentId === a.enrollmentId);
    const other = result.devices.find((d) => d.enrollmentId === b.enrollmentId);
    expect(self?.self).toBe(true);
    expect(self?.displayName).toBe('Test device');
    expect(other?.self).toBe(false);
    expect(other?.installationId).toBe('install-b');
    expect(other?.revoked).toBe(false);
    expect(JSON.stringify(result)).not.toContain('anvil_at_');
  });

  it('device.rename updates a sibling device and clears on empty', async () => {
    const { a, b } = await twoDevices();
    const renamed = await postRpc(
      'device.rename',
      { enrollmentId: b.enrollmentId, displayName: 'Office Mac' },
      bearer(a),
    );
    expectSuccess<DeviceRenameResult>(renamed);
    const listed = await postRpc('device.list', {}, bearer(a));
    const devices = expectSuccess<DeviceListResult>(listed).devices;
    expect(devices.find((d) => d.enrollmentId === b.enrollmentId)?.displayName).toBe(
      'Office Mac',
    );
    // Empty clears the name.
    await postRpc(
      'device.rename',
      { enrollmentId: b.enrollmentId, displayName: '' },
      bearer(a),
    );
    const cleared = expectSuccess<DeviceListResult>(
      await postRpc('device.list', {}, bearer(a)),
    ).devices;
    expect(
      cleared.find((d) => d.enrollmentId === b.enrollmentId)?.displayName,
    ).toBeUndefined();
  });

  it('device.rename rejects cross-account and unknown enrollments', async () => {
    const { a } = await twoDevices();
    const foreign = await freshSession();
    const crossAccount = await postRpc(
      'device.rename',
      { enrollmentId: foreign.enrollmentId, displayName: 'x' },
      bearer(a),
    );
    expect(crossAccount.status).toBe(httpStatusForErrorCode('not-found'));
    const unknown = await postRpc(
      'device.rename',
      { enrollmentId: 'enr-nope', displayName: 'x' },
      bearer(a),
    );
    expect(unknown.status).toBe(httpStatusForErrorCode('not-found'));
  });

  it('device.revoke kills the sibling session and stays listed as revoked', async () => {
    const { a, b } = await twoDevices();
    const revoked = await postRpc(
      'device.revoke',
      { enrollmentId: b.enrollmentId },
      bearer(a),
    );
    expectSuccess<DeviceRevokeResult>(revoked);
    // The revoked device's bearer no longer authenticates.
    const dead = await postRpc('sync.pull', { cursor: null, maxBytes: 1024 }, bearer(b));
    expect(dead.status).toBe(httpStatusForErrorCode('unauthenticated'));
    // And it cannot manage devices itself.
    const deadList = await postRpc('device.list', {}, bearer(b));
    expect(deadList.status).toBe(httpStatusForErrorCode('unauthenticated'));
    // Still visible to the account for audit.
    const listed = expectSuccess<DeviceListResult>(
      await postRpc('device.list', {}, bearer(a)),
    ).devices;
    expect(listed.find((d) => d.enrollmentId === b.enrollmentId)?.revoked).toBe(true);
    // Idempotent retry reports revoked.
    const again = await postRpc(
      'device.revoke',
      { enrollmentId: b.enrollmentId },
      bearer(a),
    );
    expectSuccess<DeviceRevokeResult>(again);
  });

  it('device.revoke of an unknown enrollment is not-found, not silently revoked', async () => {
    const { a } = await twoDevices();
    const missing = await postRpc(
      'device.revoke',
      { enrollmentId: 'enr-ghost' },
      bearer(a),
    );
    expect(missing.status).toBe(httpStatusForErrorCode('not-found'));
  });
});

describe('credential and namespace isolation', () => {
  it('routes sync traffic by the session account, never a caller field', async () => {
    env.ENROLLMENT_ADMIN_TOKEN = ADMIN_TOKEN;
    const accountA = `acct-a-${crypto.randomUUID()}`;
    const accountB = `acct-b-${crypto.randomUUID()}`;
    const sessionA = await enrollWithCode((await issueCode(accountA)).code);
    const sessionB = await enrollWithCode((await issueCode(accountB)).code);

    // Push under A, then confirm B's pull sees nothing of it.
    const { hashedChange } = await import('./helpers');
    const change = await hashedChange({
      enrollmentSequence: 1,
      entityId: 'ws-isolation',
      payload: { name: 'A only' },
    });
    await postRpc('sync.push', { changes: [change] }, bearer(sessionA));
    const pullB = await postRpc('sync.pull', { cursor: null, maxBytes: 65536 }, bearer(sessionB));
    const resultB = expectSuccess<SyncPullResult>(pullB);
    expect(resultB.changes).toHaveLength(0);
  });

  it('rejects the spike bearer format when it is not a device token', async () => {
    // ANVIL_DEV_SPIKE is on in test config; a malformed spike still fails.
    const { status } = await postRpc(
      'sync.pull',
      { cursor: null, maxBytes: 1024 },
      'Bearer spike:',
    );
    expect(status).toBe(httpStatusForErrorCode('unauthenticated'));
  });
});

describe('OIDC-PKCE proof verification', () => {
  const issuer = 'https://issuer.test';
  const clientId = 'anvil-test-client';

  async function makeIssuer() {
    const keyPair = (await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true,
      ['sign', 'verify'],
    )) as CryptoKeyPair;
    const publicJwk = (await crypto.subtle.exportKey('jwk', keyPair.publicKey)) as JsonWebKey & {
      kid?: string;
      use?: string;
      alg?: string;
    };
    publicJwk.kid = 'test-key-1';
    publicJwk.use = 'sig';
    publicJwk.alg = 'RS256';
    const codes = new Map<string, { redirectUri: string; verifier: string; nonce: string; sub: string }>();

    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url === `${issuer}/.well-known/openid-configuration`) {
        return Response.json({
          issuer,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks.json`,
        });
      }
      if (url === `${issuer}/jwks.json`) {
        return Response.json({ keys: [publicJwk] });
      }
      if (url === `${issuer}/token`) {
        const params = new URLSearchParams(init?.body as string);
        const code = params.get('code') ?? '';
        const grant = codes.get(code);
        if (
          grant === undefined ||
          params.get('code_verifier') !== grant.verifier ||
          params.get('redirect_uri') !== grant.redirectUri ||
          params.get('client_id') !== clientId ||
          params.get('grant_type') !== 'authorization_code'
        ) {
          return Response.json({ error: 'invalid_grant' }, { status: 400 });
        }
        codes.delete(code);
        const header = base64Url(JSON.stringify({ alg: 'RS256', kid: 'test-key-1' }));
        const claims = base64Url(
          JSON.stringify({
            iss: issuer,
            sub: grant.sub,
            aud: clientId,
            exp: Math.floor(Date.now() / 1000) + 300,
            nonce: grant.nonce,
          }),
        );
        const signature = await crypto.subtle.sign(
          { name: 'RSASSA-PKCS1-v1_5' },
          keyPair.privateKey,
          new TextEncoder().encode(`${header}.${claims}`),
        );
        const idToken = `${header}.${claims}.${base64UrlBytes(new Uint8Array(signature))}`;
        return Response.json({ id_token: idToken, access_token: 'at', token_type: 'Bearer' });
      }
      return new Response('not found', { status: 404 });
    }) as typeof fetch;

    return { codes, fetchFn };
  }

  function base64Url(text: string): string {
    return base64UrlBytes(new TextEncoder().encode(text));
  }

  function base64UrlBytes(bytes: Uint8Array): string {
    let binary = '';
    for (const byte of bytes) {
      binary += String.fromCharCode(byte);
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  it('verifies a real signed id_token and returns the subject', async () => {
    const { codes, fetchFn } = await makeIssuer();
    codes.set('code-1', {
      redirectUri: 'http://127.0.0.1:50000/callback',
      verifier: 'verifier-1',
      nonce: 'nonce-1',
      sub: 'user-42',
    });
    const sub = await verifyOidcPkceProof(
      {
        method: 'oidc-pkce',
        issuer,
        authorizationCode: 'code-1',
        codeVerifier: 'verifier-1',
        redirectUri: 'http://127.0.0.1:50000/callback',
        nonce: 'nonce-1',
      },
      { issuer, clientId },
      fetchFn,
    );
    expect(sub).toBe('user-42');
  });

  it('rejects a wrong code_verifier at the token exchange', async () => {
    const { codes, fetchFn } = await makeIssuer();
    codes.set('code-2', {
      redirectUri: 'http://127.0.0.1:50000/callback',
      verifier: 'right-verifier',
      nonce: 'n',
      sub: 'user-1',
    });
    const sub = await verifyOidcPkceProof(
      {
        method: 'oidc-pkce',
        issuer,
        authorizationCode: 'code-2',
        codeVerifier: 'wrong-verifier',
        redirectUri: 'http://127.0.0.1:50000/callback',
        nonce: 'n',
      },
      { issuer, clientId },
      fetchFn,
    );
    expect(sub).toBeNull();
  });

  it('rejects a token signed by an unknown key', async () => {
    const { codes, fetchFn } = await makeIssuer();
    const rogue = (await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true,
      ['sign'],
    )) as CryptoKeyPair;
    codes.set('code-3', {
      redirectUri: 'http://127.0.0.1:50000/callback',
      verifier: 'v',
      nonce: 'n',
      sub: 'user-9',
    });
    // Wrap the issuer fetch but replace the token response with a rogue-signed JWT.
    const wrappedFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await fetchFn(input, init);
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url !== `${issuer}/token` || !response.ok) {
        return response;
      }
      const header = base64Url(JSON.stringify({ alg: 'RS256', kid: 'rogue' }));
      const claims = base64Url(
        JSON.stringify({ iss: issuer, sub: 'user-9', aud: clientId, exp: Math.floor(Date.now() / 1000) + 300, nonce: 'n' }),
      );
      const sig = await crypto.subtle.sign(
        { name: 'RSASSA-PKCS1-v1_5' },
        rogue.privateKey,
        new TextEncoder().encode(`${header}.${claims}`),
      );
      return Response.json({ id_token: `${header}.${claims}.${base64UrlBytes(new Uint8Array(sig))}` });
    }) as typeof fetch;
    const sub = await verifyOidcPkceProof(
      {
        method: 'oidc-pkce',
        issuer,
        authorizationCode: 'code-3',
        codeVerifier: 'v',
        redirectUri: 'http://127.0.0.1:50000/callback',
        nonce: 'n',
      },
      { issuer, clientId },
      wrappedFetch,
    );
    expect(sub).toBeNull();
  });

  it('rejects a nonce mismatch after a valid exchange', async () => {
    const { codes, fetchFn } = await makeIssuer();
    codes.set('code-4', {
      redirectUri: 'http://127.0.0.1:50000/callback',
      verifier: 'v4',
      nonce: 'server-nonce',
      sub: 'user-7',
    });
    const sub = await verifyOidcPkceProof(
      {
        method: 'oidc-pkce',
        issuer,
        authorizationCode: 'code-4',
        codeVerifier: 'v4',
        redirectUri: 'http://127.0.0.1:50000/callback',
        nonce: 'different-nonce',
      },
      { issuer, clientId },
      fetchFn,
    );
    expect(sub).toBeNull();
  });
});
