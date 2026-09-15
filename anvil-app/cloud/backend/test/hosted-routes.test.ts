import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

import type { DeviceSession, EnrollmentCodeIssueResult } from '../../contract/auth';
import { sha256Hex } from '../src/hash';
import type { HostedIdentity } from '../src/hosted/identity';
import { handleHostedRequest } from '../src/hosted/routes';
import { signHostedServiceRequest } from '../src/hosted/service-auth';
import {
  consumeServiceNonce,
  getOrCreateBillingAccount,
  markBillingLifecycle,
} from '../src/hosted/store';
import migrationSql from '../migrations/hosted-billing/0001_init.sql?raw';

const ADMIN_TOKEN = 'dev-admin-token';
const SERVICE_KEY_ID = 'test';
const SERVICE_SECRET = 'a'.repeat(32);
const SERVICE_AUDIENCE = 'anvil-hosted';

function hostedDb(): D1Database {
  const db = env.HOSTED_DB;
  if (db === undefined) throw new Error('HOSTED_DB binding missing in test env');
  return db;
}

beforeEach(async () => {
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

function makeIdentity(tag: string): HostedIdentity {
  return { workosClientId: `client_${tag}`, workosUserId: `user_${tag}` };
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
  const response = await SELF.fetch(
    new Request(url, { method: 'POST', headers, body: payload }),
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function enrollWithCode(code: string, installationId = 'install-hosted'): Promise<DeviceSession> {
  const response = await SELF.fetch('https://spike.test/v1/enroll', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      proof: { method: 'enrollment-code', code },
      installationId,
      displayName: 'Hosted test device',
    }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as DeviceSession;
}

/** Enrolls a fresh device on an arbitrary account via the admin code path. */
async function deviceOnAccount(accountId: string): Promise<DeviceSession> {
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
  return enrollWithCode(code);
}

async function postHostedLink(
  linkCode: string,
  accessToken?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await SELF.fetch('https://spike.test/v1/hosted/link', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(accessToken === undefined ? {} : { Authorization: `Bearer ${accessToken}` }),
    },
    body: JSON.stringify({ linkCode }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe('hosted service auth gate', () => {
  const identity = makeIdentity('gate');

  it('rejects unsigned and wrongly-signed requests with 401', async () => {
    const unsigned = await SELF.fetch('https://spike.test/internal/hosted/pair-device', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(identity),
    });
    expect(unsigned.status).toBe(401);
    expect((await unsigned.json() as { error: { code: string } }).error.code).toBe('unauthenticated');

    const wrongKey = await signedHostedPost('/internal/hosted/pair-device', identity, {
      secret: 'b'.repeat(32),
    });
    expect(wrongKey.status).toBe(401);
  });

  it('rejects a replayed signature via the D1 nonce store', async () => {
    const payload = new TextEncoder().encode(JSON.stringify(identity));
    const url = 'https://spike.test/internal/hosted/pair-device';
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

describe('hosted pair-device', () => {
  it('enrolls devices onto one derived account per WorkOS identity', async () => {
    const identityA = makeIdentity(`a-${crypto.randomUUID()}`);
    const pair1 = await signedHostedPost('/internal/hosted/pair-device', {
      ...identityA,
      displayName: 'Work laptop',
    });
    expect(pair1.status).toBe(200);
    const accountId1 = pair1.body['accountId'] as string;
    expect(accountId1).toMatch(/^workos_[a-f0-9]{64}$/);
    expect(pair1.body['code'] as string).toMatch(/^anvil-ec-/);

    const session1 = await enrollWithCode(pair1.body['code'] as string, 'inst-1');
    expect(session1.accountId).toBe(accountId1);

    // Pairing again mints another code for the SAME sync account.
    const pair2 = await signedHostedPost('/internal/hosted/pair-device', identityA);
    expect(pair2.status).toBe(200);
    expect(pair2.body['accountId']).toBe(accountId1);
    const session2 = await enrollWithCode(pair2.body['code'] as string, 'inst-2');
    expect(session2.accountId).toBe(accountId1);
    expect(session2.enrollmentId).not.toBe(session1.enrollmentId);

    // A different user, and the same user under a different WorkOS client,
    // each resolve to different accounts.
    const identityB = makeIdentity(`b-${crypto.randomUUID()}`);
    const pairB = await signedHostedPost('/internal/hosted/pair-device', identityB);
    expect(pairB.status).toBe(200);
    expect(pairB.body['accountId']).not.toBe(accountId1);

    const pairOtherClient = await signedHostedPost('/internal/hosted/pair-device', {
      workosClientId: `client_other-${crypto.randomUUID()}`,
      workosUserId: identityA.workosUserId,
    });
    expect(pairOtherClient.status).toBe(200);
    expect(pairOtherClient.body['accountId']).not.toBe(accountId1);
  });

  it('rolls to the next generation when the mapped sync account is tombstoned', async () => {
    const identity = makeIdentity(`del-${crypto.randomUUID()}`);
    const pair1 = await signedHostedPost('/internal/hosted/pair-device', identity);
    const session = await enrollWithCode(pair1.body['code'] as string);

    // Deleting the device account tombstones workos_<hash>.
    const deleted = await SELF.fetch('https://spike.test/v1/rpc', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.accessToken}`,
      },
      body: JSON.stringify({
        protocol: 'anvil-backend/1',
        requestId: crypto.randomUUID(),
        operation: 'account.delete',
        params: {},
      }),
    });
    expect(deleted.status).toBe(200);

    const pair2 = await signedHostedPost('/internal/hosted/pair-device', identity);
    expect(pair2.status).toBe(200);
    const nextAccount = `${pair1.body['accountId']}~2`;
    expect(pair2.body['accountId']).toBe(nextAccount);

    const session2 = await enrollWithCode(pair2.body['code'] as string, 'inst-gen2');
    expect(session2.accountId).toBe(nextAccount);

    const account = await signedHostedPost('/internal/hosted/account', identity);
    expect(account.status).toBe(200);
    expect(account.body['syncAccountId']).toBe(nextAccount);
    expect(account.body['generation']).toBe(2);
  });
});

describe('hosted device link flow', () => {
  it('links an existing device account to a billing identity', async () => {
    const device = await deviceOnAccount(`acct-${crypto.randomUUID()}`);
    const identity = makeIdentity(`link-${crypto.randomUUID()}`);
    const billing = await getOrCreateBillingAccount(hostedDb(), identity);

    const minted = await signedHostedPost('/internal/hosted/link-code', identity);
    expect(minted.status).toBe(200);
    const linkCode = minted.body['linkCode'] as string;
    expect(linkCode).toMatch(/^anvil-lc-/);

    const linked = await postHostedLink(linkCode, device.accessToken);
    expect(linked.status).toBe(200);
    expect(linked.body['linked']).toBe(true);
    expect(linked.body['billingAccountId']).toBe(billing.id);

    const account = await signedHostedPost('/internal/hosted/account', identity);
    expect(account.body['syncAccountId']).toBe(device.accountId);
    expect(account.body['lifecycle']).toBe('active');
  });

  it('rejects a second billing identity claiming the same sync account', async () => {
    const device = await deviceOnAccount(`acct-${crypto.randomUUID()}`);
    const identityC = makeIdentity(`c-${crypto.randomUUID()}`);
    await getOrCreateBillingAccount(hostedDb(), identityC);
    const codeC = await signedHostedPost('/internal/hosted/link-code', identityC);
    expect((await postHostedLink(codeC.body['linkCode'] as string, device.accessToken)).status).toBe(200);

    const identityD = makeIdentity(`d-${crypto.randomUUID()}`);
    await getOrCreateBillingAccount(hostedDb(), identityD);
    const codeD = await signedHostedPost('/internal/hosted/link-code', identityD);
    const denied = await postHostedLink(codeD.body['linkCode'] as string, device.accessToken);
    expect(denied.status).toBe(409);
    const error = denied.body['error'] as { code: string; retryable: boolean; details: { reason: string } };
    expect(error.code).toBe('conflict');
    expect(error.retryable).toBe(false);
    expect(error.details.reason).toBe('sync-account-claimed');
  });

  it('rejects relinking a billing account to a different sync account', async () => {
    const deviceX = await deviceOnAccount(`acct-x-${crypto.randomUUID()}`);
    const deviceY = await deviceOnAccount(`acct-y-${crypto.randomUUID()}`);
    const identity = makeIdentity(`reloc-${crypto.randomUUID()}`);
    await getOrCreateBillingAccount(hostedDb(), identity);

    const first = await signedHostedPost('/internal/hosted/link-code', identity);
    expect((await postHostedLink(first.body['linkCode'] as string, deviceX.accessToken)).status).toBe(200);

    const second = await signedHostedPost('/internal/hosted/link-code', identity);
    const denied = await postHostedLink(second.body['linkCode'] as string, deviceY.accessToken);
    expect(denied.status).toBe(409);
    expect(
      (denied.body['error'] as { details: { reason: string } }).details.reason,
    ).toBe('already-linked');
  });

  it('rejects consumed, wrong, and expired link codes with 401', async () => {
    const device = await deviceOnAccount(`acct-${crypto.randomUUID()}`);
    const identity = makeIdentity(`reuse-${crypto.randomUUID()}`);
    const billing = await getOrCreateBillingAccount(hostedDb(), identity);

    const minted = await signedHostedPost('/internal/hosted/link-code', identity);
    const linkCode = minted.body['linkCode'] as string;
    expect((await postHostedLink(linkCode, device.accessToken)).status).toBe(200);
    // Replay of the consumed code is an authentication failure.
    const replay = await postHostedLink(linkCode, device.accessToken);
    expect(replay.status).toBe(401);
    expect((replay.body['error'] as { code: string }).code).toBe('unauthenticated');

    const wrong = await postHostedLink('anvil-lc-AAAAA-BBBBB-CCCCC-DDDDD', device.accessToken);
    expect(wrong.status).toBe(401);

    // Force-expire a fresh code in D1 rather than waiting out the TTL.
    const expired = await signedHostedPost('/internal/hosted/link-code', identity);
    await hostedDb()
      .prepare('UPDATE hosted_link_codes SET expires_at = ? WHERE billing_account_id = ?')
      .bind(Date.now() - 1, billing.id)
      .run();
    const stale = await postHostedLink(expired.body['linkCode'] as string, device.accessToken);
    expect(stale.status).toBe(401);
  });

  it('requires a device bearer and a well-formed body', async () => {
    const noBearer = await postHostedLink('anvil-lc-AAAAA-BBBBB-CCCCC-DDDDD');
    expect(noBearer.status).toBe(401);

    const malformed = await SELF.fetch('https://spike.test/v1/hosted/link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(malformed.status).toBe(400);
  });

  it('throttles the sixth concurrent live link code for one account', async () => {
    const identity = makeIdentity(`cap-${crypto.randomUUID()}`);
    await getOrCreateBillingAccount(hostedDb(), identity);
    for (let i = 0; i < 5; i += 1) {
      expect((await signedHostedPost('/internal/hosted/link-code', identity)).status).toBe(200);
    }
    const sixth = await signedHostedPost('/internal/hosted/link-code', identity);
    expect(sixth.status).toBe(429);
    expect((sixth.body['error'] as { code: string }).code).toBe('throttled');
  });

  it('returns not-found for link-code and account lookups of unknown identities', async () => {
    const unknown = makeIdentity(`ghost-${crypto.randomUUID()}`);
    expect((await signedHostedPost('/internal/hosted/link-code', unknown)).status).toBe(404);
    expect((await signedHostedPost('/internal/hosted/account', unknown)).status).toBe(404);
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
