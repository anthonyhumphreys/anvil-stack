import { env, SELF } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DeviceSession, EnrollmentCodeIssueResult } from '../../contract/auth';
import { WORKOS_AUTHKIT_ISSUER } from '../../contract/auth';
import type { HostedIdentity } from '../src/hosted/identity';
import { handleHostedRequest } from '../src/hosted/routes';
import { signHostedServiceRequest } from '../src/hosted/service-auth';
import {
  bumpGeneration,
  consumeServiceNonce,
  getBillingAccountByIdentity,
  getOrCreateBillingAccount,
  markBillingLifecycle,
  setSyncAccountLink,
} from '../src/hosted/store';
import migrationSql from '../migrations/hosted-billing/0001_init.sql?raw';
import { postRpc, withSelfHostedBackend } from './helpers';

const ADMIN_TOKEN = 'dev-admin-token';
const SERVICE_KEY_ID = 'test';
const SERVICE_SECRET = 'a'.repeat(32);
const SERVICE_AUDIENCE = 'anvil-hosted';
const WORKOS_API = 'https://api.workos.com';

function hostedDb(): D1Database {
  const db = env.HOSTED_DB;
  if (db === undefined) throw new Error('HOSTED_DB binding missing in test env');
  return db;
}

beforeEach(async () => {
  env.OIDC_ISSUER = undefined;
  env.OIDC_CLIENT_ID = undefined;
  env.HOSTED_WORKOS_CLIENT_ID = undefined;
  env.ENROLLMENT_ADMIN_TOKEN = undefined;
  await fetch(`${WORKOS_API}/__workos-stub/reset`, { method: 'POST' });
  // workerd's D1 exec treats each LINE as a statement, so the file is
  // applied statement-by-statement instead. The migration deliberately
  // keeps semicolons out of strings/comments, making the `;` split safe.
  const statements = migrationSql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
  const db = hostedDb();
  await db.batch(statements.map((statement) => db.prepare(statement)));
});

afterEach(async () => {
  const pending = (await (await fetch(`${WORKOS_API}/__workos-stub/pending`)).json()) as {
    pending: unknown[];
  };
  expect(pending.pending).toEqual([]);
});

function makeIdentity(tag: string): HostedIdentity {
  return { workosClientId: 'client_hosted_test', workosUserId: `user_${tag}` };
}

async function enrollWithWorkOS(identity: HostedIdentity, installationId: string): Promise<DeviceSession> {
  env.OIDC_ISSUER = WORKOS_AUTHKIT_ISSUER;
  env.OIDC_CLIENT_ID = identity.workosClientId;
  env.HOSTED_WORKOS_CLIENT_ID = identity.workosClientId;
  const deviceCode = `device-${crypto.randomUUID()}`;
  const queued = await fetch(`${WORKOS_API}/__workos-stub/enqueue`, {
    method: 'POST',
    body: JSON.stringify({
      method: 'POST',
      path: '/user_management/authenticate',
      body: { user: { object: 'user', id: identity.workosUserId } },
    }),
  });
  expect(queued.status).toBe(200);

  const request = () =>
    SELF.fetch('https://spike.test/v1/enroll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        proof: { method: 'workos-device', issuer: WORKOS_AUTHKIT_ISSUER, deviceCode },
        installationId,
      }),
    });
  let response = await request();
  if (response.status === 429) {
    await response.body?.cancel();
    await new Promise((resolve) => setTimeout(resolve, 1_010));
    response = await request();
  }
  expect(response.status).toBe(200);
  return (await response.json()) as DeviceSession;
}

/** Signs and POSTs a service request to an /internal/hosted/* route. */
async function signedHostedPost(
  path: string,
  body: unknown,
  options: { keyId?: string; secret?: string; requestId?: string } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const payload = new TextEncoder().encode(JSON.stringify(body));
  const url = `https://spike.test${path}`;
  const headers = await signHostedServiceRequest(
    new Request(url, { method: 'POST' }),
    payload,
    {
      audience: SERVICE_AUDIENCE,
      keyId: options.keyId ?? SERVICE_KEY_ID,
      secret: options.secret ?? SERVICE_SECRET,
    },
    Date.now(),
    options.requestId,
  );
  const response = await SELF.fetch(new Request(url, { method: 'POST', headers, body: payload }));
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** Enrolls a fresh device on an arbitrary account via the admin code path. */
async function deviceOnAccount(accountId: string): Promise<DeviceSession> {
  return withSelfHostedBackend(async () => {
    env.ENROLLMENT_ADMIN_TOKEN = ADMIN_TOKEN;
    const issued = await SELF.fetch('https://spike.test/v1/enrollment-codes', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ADMIN_TOKEN}`,
      },
      body: JSON.stringify({ accountId }),
    });
    expect(issued.status).toBe(200);
    const { code } = (await issued.json()) as EnrollmentCodeIssueResult;
    const response = await SELF.fetch('https://spike.test/v1/enroll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        proof: { method: 'enrollment-code', code },
        installationId: `device-on-account-${crypto.randomUUID()}`,
      }),
    });
    expect(response.status).toBe(200);
    return (await response.json()) as DeviceSession;
  });
}

describe('hosted service auth gate', () => {
  const identity = makeIdentity('gate');

  it('rejects unsigned and wrongly-signed requests with 401', async () => {
    const unsigned = await SELF.fetch('https://spike.test/internal/hosted/account', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(identity),
    });
    expect(unsigned.status).toBe(401);
    expect(((await unsigned.json()) as { error: { code: string } }).error.code).toBe(
      'unauthenticated',
    );

    const wrongKey = await signedHostedPost('/internal/hosted/account', identity, {
      secret: 'b'.repeat(32),
    });
    expect(wrongKey.status).toBe(401);
  });

  it('rejects a replayed signature via the D1 nonce store', async () => {
    await getOrCreateBillingAccount(hostedDb(), identity);
    const payload = new TextEncoder().encode(JSON.stringify(identity));
    const url = 'https://spike.test/internal/hosted/account';
    const headers = await signHostedServiceRequest(
      new Request(url, { method: 'POST' }),
      payload,
      { audience: SERVICE_AUDIENCE, keyId: SERVICE_KEY_ID, secret: SERVICE_SECRET },
      Date.now(),
      'replay-test-request-1',
    );
    const first = await SELF.fetch(new Request(url, { method: 'POST', headers, body: payload }));
    expect(first.status).toBe(200);
    const replay = await SELF.fetch(new Request(url, { method: 'POST', headers, body: payload }));
    expect(replay.status).toBe(401);
  });
});

describe('hosted enrollment policy', () => {
  it('removes the hosted pair and account-link routes', async () => {
    for (const path of ['/internal/hosted/pair-device', '/internal/hosted/link-code']) {
      expect((await signedHostedPost(path, makeIdentity(`removed-${crypto.randomUUID()}`))).status)
        .toBe(404);
    }
    const publicLink = await SELF.fetch('https://spike.test/v1/hosted/link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ linkCode: 'anvil-lc-AAAAA-BBBBB-CCCCC-DDDDD' }),
    });
    expect(publicLink.status).toBe(404);
  });

  it('rejects durable code issuance and redemption on a hosted worker, including old codes', async () => {
    const accountId = `acct-hosted-code-${crypto.randomUUID()}`;
    env.ENROLLMENT_ADMIN_TOKEN = ADMIN_TOKEN;
    const issued = await withSelfHostedBackend(async () =>
      SELF.fetch('https://spike.test/v1/enrollment-codes', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ADMIN_TOKEN}`,
        },
        body: JSON.stringify({ accountId }),
      }),
    );
    expect(issued.status).toBe(200);
    const { code } = (await issued.json()) as EnrollmentCodeIssueResult;

    const mintBlocked = await SELF.fetch('https://spike.test/v1/enrollment-codes', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ADMIN_TOKEN}`,
      },
      body: JSON.stringify({ accountId: `acct-unmapped-${crypto.randomUUID()}` }),
    });
    expect(mintBlocked.status).toBe(403);
    expect(await mintBlocked.json()).toMatchObject({
      error: { code: 'forbidden', details: { reason: 'provider-sign-in-required' } },
    });

    const redeemBlocked = await SELF.fetch('https://spike.test/v1/enroll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        proof: { method: 'enrollment-code', code },
        installationId: 'legacy-hosted-code',
      }),
    });
    expect(redeemBlocked.status).toBe(403);
    expect(await redeemBlocked.json()).toMatchObject({
      error: { code: 'forbidden', details: { reason: 'provider-sign-in-required' } },
    });
  });

  it('keeps internal ephemeral enrollment available and prevents it from minting codes', async () => {
    const sessions = env.SESSIONS.get(env.SESSIONS.idFromName('sessions'));
    const issued = await sessions.fetch('https://internal.anvil/internal/issue-enrollment-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accountId: `acct-ephemeral-${crypto.randomUUID()}`,
        enrollmentClass: 'ephemeral',
        provider: 'codex',
        sessionTtlSeconds: 300,
        environmentId: 'env-hosted-test',
      }),
    });
    expect(issued.status).toBe(200);
    const { code } = (await issued.json()) as EnrollmentCodeIssueResult;

    const enrolled = await SELF.fetch('https://spike.test/v1/enroll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        proof: { method: 'enrollment-code', code },
        installationId: 'internal-agent-hosted-test',
      }),
    });
    expect(enrolled.status).toBe(200);
    const session = (await enrolled.json()) as DeviceSession;
    expect(session.enrollmentClass).toBe('ephemeral');
    expect(session.environmentId).toBe('env-hosted-test');

    const mint = await SELF.fetch('https://spike.test/v1/enrollment-codes', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.accessToken}`,
      },
      body: JSON.stringify({ enrollmentClass: 'ephemeral', provider: 'codex' }),
    });
    expect(mint.status).toBe(403);
  });

  it('advances a reset hosted account without letting data-status lock its billing row', async () => {
    const identity = makeIdentity(`reset-${crypto.randomUUID()}`);
    const billingBefore = await getOrCreateBillingAccount(hostedDb(), identity);
    const first = await enrollWithWorkOS(identity, 'reset-first-device');
    const oldAccountId = first.accountId;
    expect((await getBillingAccountByIdentity(hostedDb(), identity))?.sync_account_id).toBe(
      oldAccountId,
    );

    const reset = await postRpc(
      'security.reset',
      { accountId: oldAccountId, confirmation: 'RESET ENCRYPTED DATA' },
      `Bearer ${first.accessToken}`,
    );
    expect(reset.status).toBe(200);
    expect((reset.body as { result?: { reauthRequired?: boolean } }).result?.reauthRequired).toBe(
      true,
    );
    expect((await postRpc('device.list', {}, `Bearer ${first.accessToken}`)).status).toBe(401);

    const newAccountId = `${oldAccountId}~2`;
    const statusAfterReset = await signedHostedPost('/internal/hosted/data-status', identity);
    expect(statusAfterReset.status).toBe(200);
    expect(statusAfterReset.body).toEqual({
      syncAccountId: newAccountId,
      tombstoned: false,
      deletion: { state: 'none' },
    });
    const billingAfterStatus = await getBillingAccountByIdentity(hostedDb(), identity);
    expect(billingAfterStatus?.id).toBe(billingBefore.id);
    expect(billingAfterStatus?.lifecycle).toBe('active');
    expect(billingAfterStatus?.generation).toBe(2);
    expect(billingAfterStatus?.sync_account_id).toBe(newAccountId);

    const second = await enrollWithWorkOS(identity, 'reset-second-device');
    expect(second.accountId).toBe(newAccountId);
    const billingAfterSignIn = await getBillingAccountByIdentity(hostedDb(), identity);
    expect(billingAfterSignIn?.id).toBe(billingBefore.id);
    expect(billingAfterSignIn?.lifecycle).toBe('active');
    expect(billingAfterSignIn?.generation).toBe(2);
    expect(billingAfterSignIn?.sync_account_id).toBe(newAccountId);
  });

  it('does not apply a stale deletion probe to a newer hosted generation', async () => {
    const identity = makeIdentity(`stale-probe-${crypto.randomUUID()}`);
    const billing = await getOrCreateBillingAccount(hostedDb(), identity);
    const oldAccountId = 'old-sync-generation';
    await setSyncAccountLink(hostedDb(), billing.id, oldAccountId);
    await bumpGeneration(hostedDb(), billing.id);

    expect(await markBillingLifecycle(hostedDb(), billing.id, 'deleted', oldAccountId)).toBe(false);
    expect((await getBillingAccountByIdentity(hostedDb(), identity))?.lifecycle).toBe('active');
  });
});

describe('hosted dashboard contract relay', () => {
  it('unwraps request, status, and snapshot results from the account coordinator', async () => {
    const identity = makeIdentity(`dashboard-${crypto.randomUUID()}`);
    const billing = await getOrCreateBillingAccount(hostedDb(), identity);
    const accountId = `acct-dashboard-${crypto.randomUUID()}`;
    await setSyncAccountLink(hostedDb(), billing.id, accountId);
    const device = await deviceOnAccount(accountId);
    const requestId = crypto.randomUUID();
    const browserPub = btoa('b'.repeat(32));
    const request = await signedHostedPost('/internal/hosted/dashboard-request', {
      ...identity,
      request: {
        requestId,
        browserPub,
        challenge: 'dashboard-challenge',
        scopes: ['read-dashboard'],
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      },
    });
    expect(request.status).toBe(200);
    expect(request.body['request']).toMatchObject({ requestId, state: 'pending' });
    expect(request.body['result']).toBeUndefined();

    const rpc = await SELF.fetch('https://spike.test/v1/rpc', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${device.accessToken}`,
      },
      body: JSON.stringify({
        protocol: 'anvil-backend/1',
        requestId: crypto.randomUUID(),
        operation: 'dashboard.decide',
        params: {
          requestId,
          decision: 'approved',
          grant: {
            v: 1,
            enc: 'x25519-aes-256-gcm',
            requestId,
            browserPub,
            expiresAt: new Date(Date.now() + 600_000).toISOString(),
            ephPub: btoa('e'.repeat(32)),
            nonce: btoa('n'.repeat(12)),
            ct: btoa('sealed-grant'),
          },
          snapshot: {
            enc: 'aes-256-gcm',
            seq: 1,
            nonce: btoa('s'.repeat(12)),
            ct: btoa('sealed-snapshot'),
          },
        },
      }),
    });
    expect(rpc.status).toBe(200);

    const status = await signedHostedPost('/internal/hosted/dashboard-status', {
      ...identity,
      requestId,
    });
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({ requestId, state: 'approved', snapshotSeq: 1 });
    expect(status.body['grant']).toBeDefined();
    expect(status.body['result']).toBeUndefined();

    const snapshot = await signedHostedPost('/internal/hosted/dashboard-snapshot', {
      ...identity,
      requestId,
    });
    expect(snapshot.status).toBe(200);
    expect(snapshot.body).toMatchObject({ requestId, snapshot: { seq: 1 } });
    expect(snapshot.body['result']).toBeUndefined();
  });
});

describe('self-host isolation', () => {
  // No HOSTED_DB on this env: every hosted path must answer not-found.
  const selfHostEnv = {
    ACCOUNT: env.ACCOUNT,
    SESSIONS: env.SESSIONS,
    ARTIFACTS: env.ARTIFACTS,
  } as Env;

  it('answers 404 for hosted routes without HOSTED_DB', async () => {
    const link = await handleHostedRequest(
      new Request('https://selfhost.test/v1/hosted/link', {
        method: 'POST',
        body: JSON.stringify({ linkCode: 'anvil-lc-AAAAA-BBBBB-CCCCC-DDDDD' }),
      }),
      selfHostEnv,
    );
    expect(link.status).toBe(404);
    const internal = await handleHostedRequest(
      new Request('https://selfhost.test/internal/hosted/account', {
        method: 'POST',
        body: '{}',
      }),
      selfHostEnv,
    );
    expect(internal.status).toBe(404);
  });

  it('does not leak account data on an unsigned probe', async () => {
    const probe = await SELF.fetch('https://spike.test/internal/hosted/account', {
      method: 'GET',
    });
    expect(probe.status).toBe(400);
    const body = (await probe.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('malformed-request');
    expect(JSON.stringify(body)).not.toContain('billingAccountId');
  });
});

describe('hosted store units', () => {
  it('never resurrects a deleted identity row', async () => {
    const identity = makeIdentity(`dead-${crypto.randomUUID()}`);
    const billing = await getOrCreateBillingAccount(hostedDb(), identity);
    expect(billing.lifecycle).toBe('active');
    expect(await markBillingLifecycle(hostedDb(), billing.id, 'deleting')).toBe(true);
    expect(await markBillingLifecycle(hostedDb(), billing.id, 'deleted')).toBe(true);
    // getOrCreate returns the dead row rather than minting a duplicate.
    const again = await getOrCreateBillingAccount(hostedDb(), identity);
    expect(again.id).toBe(billing.id);
    expect(again.lifecycle).toBe('deleted');
    // Lifecycle ordering is one-way: no deleted -> active.
    expect(await markBillingLifecycle(hostedDb(), billing.id, 'deleting')).toBe(false);
  });

  it('dedupes service nonces by (key_id, request_id)', async () => {
    const db = hostedDb();
    const expiresAt = Date.now() + 60_000;
    expect(await consumeServiceNonce(db, 'k1', 'req-1', expiresAt)).toBe(true);
    expect(await consumeServiceNonce(db, 'k1', 'req-1', expiresAt)).toBe(false);
    // A different key id may reuse the same request id.
    expect(await consumeServiceNonce(db, 'k2', 'req-1', expiresAt)).toBe(true);
  });
});
