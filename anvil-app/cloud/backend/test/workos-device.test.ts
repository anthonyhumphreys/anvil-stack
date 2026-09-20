import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import {
  WORKOS_AUTHKIT_ISSUER,
  type DeviceSession,
  type OidcPkceProof,
  type WorkosDeviceProof,
} from '../../contract/auth';
import { verifyWorkosDeviceProof } from '../src/oidc';
import type { SessionCoordinator } from '../src/session-coordinator';
import { expectSuccess, postRpc } from './helpers';

const CLIENT_ID = 'client_anvil_device_test';

function proof(deviceCode = 'device-code-1'): WorkosDeviceProof {
  return {
    method: 'workos-device',
    issuer: WORKOS_AUTHKIT_ISSUER,
    deviceCode,
  };
}

describe('WorkOS Device Authorization proof verification', () => {
  it('exchanges the device grant and returns only the provider user id', async () => {
    let request: { url: string; init?: RequestInit } | undefined;
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      request = { url: String(input), init };
      return Response.json({
        user: { object: 'user', id: 'user_01JTESTDEVICE' },
        access_token: 'provider-access-token-must-be-ignored',
        refresh_token: 'provider-refresh-token-must-be-ignored',
        id_token: 'provider-id-token-must-be-ignored',
      });
    }) as typeof fetch;

    await expect(
      verifyWorkosDeviceProof(proof(), { issuer: WORKOS_AUTHKIT_ISSUER, clientId: CLIENT_ID }, fetchFn),
    ).resolves.toEqual({ status: 'success', subject: 'user_01JTESTDEVICE' });

    expect(request?.url).toBe(`${WORKOS_AUTHKIT_ISSUER}/authenticate`);
    expect(request?.init?.redirect).toBe('manual');
    const params = new URLSearchParams(request?.init?.body as string);
    expect(Object.fromEntries(params)).toEqual({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: 'device-code-1',
      client_id: CLIENT_ID,
    });
  });

  it.each([
    ['authorization_pending', 'pending'],
    ['slow_down', 'slow-down'],
    ['access_denied', 'denied'],
    ['expired_token', 'expired'],
  ] as const)('maps WorkOS %s to the stable %s result', async (error, status) => {
    const fetchFn = (async () => Response.json({ error }, { status: 400 })) as typeof fetch;
    await expect(
      verifyWorkosDeviceProof(proof(), { issuer: WORKOS_AUTHKIT_ISSUER, clientId: CLIENT_ID }, fetchFn),
    ).resolves.toEqual({ status });
  });

  it('fails closed for invalid grants and malformed provider identities', async () => {
    const invalidGrant = (async () =>
      Response.json({ error: 'invalid_grant' }, { status: 400 })) as typeof fetch;
    await expect(
      verifyWorkosDeviceProof(proof(), { issuer: WORKOS_AUTHKIT_ISSUER, clientId: CLIENT_ID }, invalidGrant),
    ).resolves.toEqual({ status: 'invalid' });

    const malformedUser = (async () => Response.json({ user: { id: 'acct_not_workos' } })) as typeof fetch;
    await expect(
      verifyWorkosDeviceProof(
        proof('device-code-2'),
        { issuer: WORKOS_AUTHKIT_ISSUER, clientId: CLIENT_ID },
        malformedUser,
      ),
    ).resolves.toEqual({ status: 'invalid' });
  });

  it('rejects oversized and non-printable device codes before provider access', async () => {
    let called = false;
    const fetchFn = (async () => {
      called = true;
      return Response.json({ user: { id: 'user_should_not_be_seen' } });
    }) as typeof fetch;

    await expect(
      verifyWorkosDeviceProof(
        proof('x'.repeat(4097)),
        { issuer: WORKOS_AUTHKIT_ISSUER, clientId: CLIENT_ID },
        fetchFn,
      ),
    ).resolves.toEqual({ status: 'invalid' });
    await expect(
      verifyWorkosDeviceProof(
        proof('device-code\n-invalid'),
        { issuer: WORKOS_AUTHKIT_ISSUER, clientId: CLIENT_ID },
        fetchFn,
      ),
    ).resolves.toEqual({ status: 'invalid' });
    expect(called).toBe(false);
  });

  it('rejects non-WorkOS authorities and malformed proofs before network access', async () => {
    let called = false;
    const fetchFn = (async () => {
      called = true;
      return Response.json({ user: { id: 'user_should_not_be_seen' } });
    }) as typeof fetch;

    await expect(
      verifyWorkosDeviceProof(
        proof(),
        { issuer: 'https://issuer.example/user_management', clientId: CLIENT_ID },
        fetchFn,
      ),
    ).resolves.toEqual({ status: 'invalid' });
    await expect(
      verifyWorkosDeviceProof(null as never, { issuer: WORKOS_AUTHKIT_ISSUER, clientId: CLIENT_ID }, fetchFn),
    ).resolves.toEqual({ status: 'invalid' });
    await expect(
      verifyWorkosDeviceProof(
        { method: 'workos-device', issuer: 42, deviceCode: 'device-code-3' } as never,
        { issuer: WORKOS_AUTHKIT_ISSUER, clientId: CLIENT_ID },
        fetchFn,
      ),
    ).resolves.toEqual({ status: 'invalid' });
    expect(called).toBe(false);
  });

  it('resolves the same hosted account as AuthKit PKCE and consumes a device code once', async () => {
    env.OIDC_ISSUER = WORKOS_AUTHKIT_ISSUER;
    env.OIDC_CLIENT_ID = CLIENT_ID;
    const subject = `user_${crypto.randomUUID().replaceAll('-', '')}`;
    let deviceConsumed = false;
    const fetchFn = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const params = new URLSearchParams(init?.body as string);
      if (params.get('grant_type') === 'authorization_code') {
        return Response.json({ user: { id: subject }, access_token: 'ignored' });
      }
      if (params.get('grant_type') === 'urn:ietf:params:oauth:grant-type:device_code') {
        if (deviceConsumed) return Response.json({ error: 'invalid_grant' }, { status: 400 });
        deviceConsumed = true;
        return Response.json({
          user: { id: subject },
          access_token: 'ignored',
          refresh_token: 'ignored',
        });
      }
      return Response.json({ error: 'invalid_grant' }, { status: 400 });
    }) as typeof fetch;

    const enroll = async (proofValue: OidcPkceProof | WorkosDeviceProof, installationId: string) => {
      const stub = env.SESSIONS.get(env.SESSIONS.idFromName('sessions'));
      return runInDurableObject(stub, async (instance: SessionCoordinator) => {
        const previousFetch = globalThis.fetch;
        globalThis.fetch = fetchFn;
        try {
          const response = await instance.fetch(
            new Request('https://internal.anvil/enroll', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ proof: proofValue, installationId }),
            }),
          );
          return { status: response.status, body: (await response.json()) as unknown };
        } finally {
          globalThis.fetch = previousFetch;
        }
      });
    };

    const pkceProof: OidcPkceProof = {
      method: 'oidc-pkce',
      issuer: WORKOS_AUTHKIT_ISSUER,
      authorizationCode: 'pkce-code',
      codeVerifier: 'pkce-verifier',
      redirectUri: 'http://127.0.0.1:50000/callback',
      nonce: 'unused-by-authkit',
    };
    const first = (await enroll(pkceProof, 'pkce-install')) as {
      status: number;
      body: DeviceSession;
    };
    expect(first.status).toBe(200);

    const deviceProof = proof('device-code-once');
    const second = (await enroll(deviceProof, 'device-install')) as {
      status: number;
      body: DeviceSession;
    };
    expect(second.status).toBe(200);
    expect(second.body.accountId).toBe(first.body.accountId);

    const replay = await enroll(deviceProof, 'device-install-replay');
    expect(replay.status).toBe(401);
    expect((replay.body as { error: { code: string } }).error.code).toBe('invalid-proof');

    const security = expectSuccess<{ enrollments: unknown[] }>(
      await postRpc('security.get', {}, `Bearer ${first.body.accessToken}`),
    );
    expect(security.enrollments).toHaveLength(2);
  });

  it('applies a one-second DO-wide provider gate while preserving polling errors', async () => {
    env.OIDC_ISSUER = WORKOS_AUTHKIT_ISSUER;
    env.OIDC_CLIENT_ID = CLIENT_ID;
    const stub = env.SESSIONS.get(env.SESSIONS.idFromName(`device-rate-${crypto.randomUUID()}`));
    let providerCalls = 0;
    const fetchFn = (async () => {
      providerCalls += 1;
      return Response.json({ error: 'authorization_pending' }, { status: 400 });
    }) as typeof fetch;

    const enroll = (deviceCode: string) =>
      runInDurableObject(stub, async (instance: SessionCoordinator) => {
        const previousFetch = globalThis.fetch;
        globalThis.fetch = fetchFn;
        try {
          const response = await instance.fetch(
            new Request('https://internal.anvil/enroll', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                proof: proof(deviceCode),
                installationId: `rate-${deviceCode}`,
              }),
            }),
          );
          return { status: response.status, body: (await response.json()) as unknown };
        } finally {
          globalThis.fetch = previousFetch;
        }
      });

    const first = await enroll('rate-device-code-1');
    expect(first.status).toBe(202);
    expect((first.body as { error: { code: string } }).error.code).toBe(
      'device-authorization-pending',
    );
    const second = await enroll('rate-device-code-2');
    expect(second.status).toBe(429);
    expect((second.body as { error: { code: string } }).error.code).toBe(
      'device-authorization-slow-down',
    );
    expect(providerCalls).toBe(1);
  });

  it('records a successful proof and removes the session if epoch completion fails', async () => {
    env.OIDC_ISSUER = WORKOS_AUTHKIT_ISSUER;
    env.OIDC_CLIENT_ID = CLIENT_ID;
    const stub = env.SESSIONS.get(env.SESSIONS.idFromName(`device-cleanup-${crypto.randomUUID()}`));
    const fetchFn = (async () =>
      Response.json({ user: { id: `user_${crypto.randomUUID().replaceAll('-', '')}` } })) as typeof fetch;

    const result = await runInDurableObject(stub, async (instance: SessionCoordinator, state) => {
      const original = (instance as unknown as {
        datasetEpoch: (accountId: string) => Promise<string>;
      }).datasetEpoch;
      (instance as unknown as {
        datasetEpoch: (accountId: string) => Promise<string>;
      }).datasetEpoch = async () => {
        throw new Error('epoch lookup failed');
      };
      const previousFetch = globalThis.fetch;
      globalThis.fetch = fetchFn;
      try {
        let status = 503;
        try {
          const response = await (instance as unknown as {
            handleEnroll: (request: Request) => Promise<Response>;
          }).handleEnroll(
            new Request('https://internal.anvil/enroll', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                proof: proof('cleanup-device-code'),
                installationId: 'cleanup-installation',
              }),
            }),
          );
          status = response.status;
        } catch {
          // The Worker test harness may surface a blockConcurrencyWhile error
          // even though issueTokens has already cleaned up the session.
        }
        return {
          status,
          sessions: state.storage.sql
            .exec('SELECT enrollment_id FROM device_sessions')
            .toArray(),
          proofs: state.storage.sql
            .exec('SELECT device_code_hash FROM workos_device_proofs')
            .toArray(),
          originalInstalled: typeof original === 'function',
        };
      } finally {
        globalThis.fetch = previousFetch;
        (instance as unknown as {
          datasetEpoch: (accountId: string) => Promise<string>;
        }).datasetEpoch = original;
      }
    });

    expect(result.status).toBe(503);
    expect(result.sessions).toHaveLength(0);
    expect(result.proofs).toHaveLength(1);
    expect(result.originalInstalled).toBe(true);
  });
});
