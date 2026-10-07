import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { validateDescriptor } from '../../contract/discovery';
import { httpStatusForErrorCode, isRpcError, type RpcResponse } from '../../contract/envelope';
import { PROTOCOL } from '../../contract/version';
import { WORKOS_AUTHKIT_ISSUER } from '../../contract/auth';
import {
  buildDescriptor,
  SPIKE_DEPLOYMENT_ID,
  SPIKE_DEPLOYMENT_NAME,
} from '../src/descriptor';
import { postRpc, spikeBearer, uniqueIds } from './helpers';

describe('discovery', () => {
  it('uses explicit deployment identity when configured', () => {
    expect(
      buildDescriptor({
        ANVIL_DEPLOYMENT_ID: 'anvil-backend-production',
        ANVIL_DEPLOYMENT_NAME: 'Anvil Backend (backend-production)',
      }),
    ).toMatchObject({
      deploymentId: 'anvil-backend-production',
      displayName: 'Anvil Backend (backend-production)',
    });
  });

  it('retains the legacy identity when deployment vars are absent', () => {
    expect(buildDescriptor()).toMatchObject({
      deploymentId: SPIKE_DEPLOYMENT_ID,
      displayName: SPIKE_DEPLOYMENT_NAME,
    });
  });

  it('serves a descriptor that validates against the contract', async () => {
    const previousIssuer = env.OIDC_ISSUER;
    const previousClientId = env.OIDC_CLIENT_ID;
    env.OIDC_ISSUER = WORKOS_AUTHKIT_ISSUER;
    env.OIDC_CLIENT_ID = 'client_hosted_test';
    try {
      const response = await SELF.fetch('https://spike.test/.well-known/anvil-backend');
      expect(response.status).toBe(200);
      const body: unknown = await response.json();
      const validated = validateDescriptor(body);
      expect(validated.ok).toBe(true);
      expect(body).toEqual(buildDescriptor(env));
    } finally {
      env.OIDC_ISSUER = previousIssuer;
      env.OIDC_CLIENT_ID = previousClientId;
    }
  });
});

describe('RPC envelope and auth', () => {
  it('normalizes a long trailing-slash suffix in one path scan', async () => {
    const response = await SELF.fetch(`https://spike.test/v1/rpc${'/'.repeat(16_384)}`, {
      method: 'GET',
    });
    expect(response.status).toBe(httpStatusForErrorCode('malformed-request'));
  });

  it('rejects a missing bearer as unauthenticated 401', async () => {
    const response = await SELF.fetch('https://spike.test/v1/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        protocol: PROTOCOL,
        requestId: 'req-unauth',
        operation: 'sync.pull',
        params: { cursor: null, maxBytes: 1024 },
      }),
    });
    expect(response.status).toBe(httpStatusForErrorCode('unauthenticated'));
    const body = (await response.json()) as RpcResponse;
    expect(isRpcError(body)).toBe(true);
    if (!isRpcError(body)) {
      throw new Error('expected unauthenticated RPC error');
    }
    expect(body.error.code).toBe('unauthenticated');
  });

  it('rejects an unknown operation as unsupported-operation 400', async () => {
    const ids = uniqueIds('unsupported');
    const { status, body } = await postRpc(
      'job.definitely-not-real',
      {},
      spikeBearer(ids.accountId, ids.enrollmentId),
      'req-unsupported',
    );
    expect(status).toBe(httpStatusForErrorCode('unsupported-operation'));
    expect(isRpcError(body)).toBe(true);
    if (isRpcError(body)) {
      expect(body.error.code).toBe('unsupported-operation');
      expect(body.requestId).toBe('req-unsupported');
    }
  });
});
