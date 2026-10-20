import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkHostedAccess,
  hostedConfigIssues,
  resolveAccountEntitlement,
} from '../src/hosted/enforcement';
import { betaCodeHash, handleBetaRedeem } from '../src/hosted/beta';
import { getOrCreateBillingAccount } from '../src/hosted/store';
import { handleMachineApiRequest, issueHostedMachineAdmission } from '../src/hosted/machine-api';
import { hashedChange, postRpc, spikeBearer, uniqueIds } from './helpers';

const DAY = 86_400_000;
const db = env.HOSTED_DB!;
beforeEach(() => {
  env.HOSTED_BILLING_ENFORCEMENT = 'true';
});
afterEach(() => {
  env.HOSTED_BILLING_ENFORCEMENT = 'false';
});

async function fixture() {
  const ids = uniqueIds('paid-hosted');
  const identity = {
    workosClientId: 'client_hosted_test',
    workosUserId: `user_${crypto.randomUUID()}`,
  };
  const account = await getOrCreateBillingAccount(db, identity);
  await db
    .prepare('UPDATE billing_accounts SET sync_account_id = ? WHERE id = ?')
    .bind(ids.accountId, account.id)
    .run();
  return { ...ids, identity, account, auth: spikeBearer(ids.accountId, ids.enrollmentId) };
}
async function issueCode(accessUntil = Date.now() + DAY, redeemUntil = Date.now() + DAY) {
  const code = `anvil_beta_${crypto.randomUUID().replaceAll('-', '')}`;
  const hash = await betaCodeHash(code);
  await db
    .prepare(
      'INSERT INTO hosted_beta_codes (code_hash, redeem_until, access_until, created_at) VALUES (?, ?, ?, ?)',
    )
    .bind(hash, redeemUntil, accessUntil, Date.now())
    .run();
  return { code, hash };
}
async function redeem(identity: { workosClientId: string; workosUserId: string }, code: string) {
  return handleBetaRedeem({ ...identity, code }, env, db);
}

describe('paid hosted access and beta redemption', () => {
  it('gates direct Mesh admission, managed endpoints and session renewal without blocking release', async () => {
    const f = await fixture();
    const auth = { accountId: f.accountId, enrollmentId: f.enrollmentId };
    for (const path of [
      '/v1/mesh/admission-tickets/consume',
      '/v1/mesh/hosts/machine-1/admission-tickets',
      '/v1/mesh/hosts/machine-1/endpoint',
      '/v1/mesh/hosts/machine-1/connector-token',
      '/v1/mesh/hosts/machine-1/presence',
      '/v1/mesh/hosts/machine-1/sessions/revalidate',
    ]) {
      const response = await handleMachineApiRequest(
        new Request(`https://example.test${path}`, {
          method: 'POST',
          body: JSON.stringify({ action: 'allocate', ticket: 'test' }),
        }),
        env,
        auth,
      );
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: { code: 'subscription-required' } });
    }
    const browserAdmission = await issueHostedMachineAdmission(env, f.accountId, {
      machineId: 'machine-1',
      endpointGeneration: 'a'.repeat(16),
      clientPublicKey: 'key',
      bootstrapChallenge: 'challenge',
      grantId: 'grant',
      origin: 'https://example.test',
      requestId: 'request',
    });
    expect(browserAdmission.status).toBe(403);
    expect(await browserAdmission.json()).toMatchObject({
      error: { code: 'subscription-required' },
    });
    const release = await handleMachineApiRequest(
      new Request('https://example.test/v1/mesh/hosts/machine-1/endpoint', {
        method: 'POST',
        body: JSON.stringify({ action: 'release' }),
      }),
      env,
      auth,
    );
    expect(await release.json()).not.toMatchObject({ error: { code: 'subscription-required' } });
  });

  it('denies hosted Sync and Mesh mutations but keeps reads and export available', async () => {
    const f = await fixture();
    for (const [operation, params] of [
      ['sync.push', { changes: [] }],
      ['job.create', {}],
      ['handoff.create', {}],
    ] as const) {
      const response = await postRpc(operation, params, f.auth);
      expect(response.status).toBe(403);
      expect(response.body).toMatchObject({
        error: { details: { reason: 'subscription-required' } },
      });
    }
    expect((await postRpc('sync.pull', { cursor: null, maxBytes: 16384 }, f.auth)).status).toBe(
      200,
    );
    expect((await postRpc('data.export.begin', {}, f.auth)).status).toBe(200);
  });
  it('redeems a code once, retries idempotently, and grants both capabilities', async () => {
    const f = await fixture();
    const other = await fixture();
    const { code } = await issueCode();
    const responses = await Promise.all([redeem(f.identity, code), redeem(other.identity, code)]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 403]);
    const winner = responses[0].status === 200 ? f : other;
    expect((await redeem(winner.identity, code.toUpperCase())).status).toBe(200);
    expect(await resolveAccountEntitlement(env, winner.accountId, Date.now())).toMatchObject({
      state: 'preview',
      capabilities: { syncWrite: true, meshSubmit: true },
    });
    const change = await hashedChange({ enrollmentSequence: 1, entityId: 'beta-workspace' });
    expect((await postRpc('sync.push', { changes: [change] }, winner.auth)).status).toBe(200);
  });
  it('expires and revokes beta access without trusting the old preview flag', async () => {
    const f = await fixture();
    const until = Date.now() + DAY;
    const { code, hash } = await issueCode(until, until);
    expect((await redeem(f.identity, code)).status).toBe(200);
    expect((await resolveAccountEntitlement(env, f.accountId, until)).state).toBe('restricted');
    await db
      .prepare('UPDATE hosted_beta_codes SET revoked_at = ? WHERE code_hash = ?')
      .bind(Date.now(), hash)
      .run();
    expect((await resolveAccountEntitlement(env, f.accountId, Date.now())).state).toBe(
      'restricted',
    );
    expect((await redeem(f.identity, code)).status).toBe(403);
  });
  it('rejects invalid and expired codes and deleted accounts', async () => {
    const f = await fixture();
    const { code } = await issueCode(Date.now() + DAY, Date.now() - 1);
    expect((await redeem(f.identity, code)).status).toBe(403);
    expect((await redeem(f.identity, 'not-a-code')).status).toBe(403);
    const fresh = await issueCode();
    await db
      .prepare("UPDATE billing_accounts SET lifecycle = 'deleted' WHERE id = ?")
      .bind(f.account.id)
      .run();
    expect((await redeem(f.identity, fresh.code)).status).toBe(403);
  });
  it('fails closed during a hosted billing database outage, but never bills self-hosted deployments', async () => {
    const unavailable = {
      prepare() {
        throw new Error('D1 unavailable');
      },
    } as unknown as D1Database;
    expect(
      await checkHostedAccess({ ...env, HOSTED_DB: unavailable }, 'missing', Date.now()),
    ).toMatchObject({ allowed: false, reason: 'billing-unavailable' });
    expect(
      await checkHostedAccess({ ...env, HOSTED_DB: undefined }, 'missing', Date.now()),
    ).toMatchObject({ allowed: false, reason: 'billing-unavailable' });
    expect(
      await checkHostedAccess(
        { ...env, HOSTED_BILLING_ENFORCEMENT: 'false', HOSTED_DB: unavailable },
        'missing',
        Date.now(),
      ),
    ).toEqual({ allowed: true, entitlement: null });
  });
  it('requires the hosted bindings when enforcement is enabled', () => {
    expect(hostedConfigIssues({} as Env)).toEqual([]);
    expect(hostedConfigIssues({ HOSTED_BILLING_ENFORCEMENT: 'true' } as Env)).toEqual([
      'HOSTED_DB',
      'HOSTED_SERVICE_KEYS',
    ]);
  });
});
