import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { FAIR_USE_OPERATOR_AUDIENCE } from '../src/hosted/fair-use-admin';
import { handleHostedRequest } from '../src/hosted/routes';
import { signHostedServiceRequest } from '../src/hosted/service-auth';
import { getOrCreateBillingAccount, setSyncAccountLink } from '../src/hosted/store';

const secret = 'operator-test-secret-'.repeat(3);
const operatorEnv: Env = { ...env, HOSTED_OPERATOR_KEYS: JSON.stringify({ operations: secret }) };
const endpoint = 'https://backend.test/internal/hosted/operator/fair-use';

async function signed(body: unknown, audience = FAIR_USE_OPERATOR_AUDIENCE, key = secret) {
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  const request = new Request(endpoint, { method: 'POST', body: bytes });
  const headers = await signHostedServiceRequest(
    request,
    bytes,
    {
      audience,
      keyId: 'operations',
      secret: key,
    },
    Date.now(),
  );
  return new Request(request, { headers });
}

async function account(): Promise<string> {
  const id = crypto.randomUUID().replaceAll('-', '');
  const record = await getOrCreateBillingAccount(env.HOSTED_DB!, {
    workosClientId: `client_${id}`,
    workosUserId: `user_${id}`,
  });
  const syncId = `fairuse_${id}`;
  await setSyncAccountLink(env.HOSTED_DB!, record.id, syncId);
  return syncId;
}

describe('fair-use operator channel', () => {
  it('fails closed if an operator key is accidentally shared with the website', async () => {
    const request = await signed({ accountId: 'missing', action: 'status' });
    const response = await handleHostedRequest(request, {
      ...operatorEnv,
      HOSTED_SERVICE_KEYS: JSON.stringify({ website: secret }),
    });
    expect(response.status).toBe(404);
  });

  it('is absent when operator credentials or hosted storage are not configured', async () => {
    const request = await signed({ accountId: 'missing', action: 'status' });
    expect(
      (await handleHostedRequest(request.clone(), { ...env, HOSTED_OPERATOR_KEYS: undefined }))
        .status,
    ).toBe(404);
    expect(
      (await handleHostedRequest(request, { ...operatorEnv, HOSTED_DB: undefined })).status,
    ).toBe(404);
  });

  it('rejects the website audience even when the supplied key is valid', async () => {
    const request = await signed({ accountId: 'missing', action: 'status' }, 'anvil-hosted');
    expect((await handleHostedRequest(request, operatorEnv)).status).toBe(401);
  });

  it('rejects a website secret used with the operator audience', async () => {
    const request = await signed(
      { accountId: 'missing', action: 'status' },
      FAIR_USE_OPERATOR_AUDIENCE,
      'a'.repeat(32),
    );
    expect((await handleHostedRequest(request, operatorEnv)).status).toBe(401);
  });

  it('consumes a nonce once even when the addressed account does not exist', async () => {
    const request = await signed({ accountId: 'missing', action: 'status' });
    const replay = request.clone();
    expect((await handleHostedRequest(request, operatorEnv)).status).toBe(404);
    expect((await handleHostedRequest(replay, operatorEnv)).status).toBe(401);
  });

  it('bounds streamed bodies without trusting Content-Length', async () => {
    const request = new Request(endpoint, { method: 'POST', body: 'x'.repeat(8193) });
    expect((await handleHostedRequest(request, operatorEnv)).status).toBe(413);
  });

  it('sets a visible notice, reports it, and clears it on the same personal account', async () => {
    const accountId = await account();
    const set = await handleHostedRequest(
      await signed({
        accountId,
        action: 'set',
        code: 'storage-usage',
        message: 'Please reduce stored artifacts or contact support.',
        restrictAt: new Date(Date.now() + 8 * 86_400_000).toISOString(),
      }),
      operatorEnv,
    );
    expect(set.status).toBe(200);
    const status = await handleHostedRequest(
      await signed({ accountId, action: 'status' }),
      operatorEnv,
    );
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ status: 'notice' });
    const clear = await handleHostedRequest(
      await signed({ accountId, action: 'clear' }),
      operatorEnv,
    );
    expect(clear.status).toBe(200);
    const after = await handleHostedRequest(
      await signed({ accountId, action: 'status' }),
      operatorEnv,
    );
    expect(await after.json()).toMatchObject({ status: 'clear' });
  });

  it('does not permit immediate ordinary restrictions without the notice period', async () => {
    const accountId = await account();
    const response = await handleHostedRequest(
      await signed({
        accountId,
        action: 'set',
        code: 'storage-usage',
        message: 'Please contact support.',
        restrictAt: new Date().toISOString(),
      }),
      operatorEnv,
    );
    expect(response.status).toBe(400);
  });
});
