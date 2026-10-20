import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  getOrCreateAdmittedBillingAccount,
  isHostedIdentityAdmitted,
} from '../src/hosted/admission';
import type { HostedIdentity } from '../src/hosted/identity';
import { WorkOSRequestError } from '../src/hosted/workos';
import { getBillingAccountByIdentity, getOrCreateBillingAccount } from '../src/hosted/store';

const WORKOS_API = 'https://api.workos.com';
const HOSTED_CLIENT_ID = 'client_anvil_hosted_test';
const WORKOS_API_KEY = 'sk_test_workos_fake';

function hostedDb(): D1Database {
  const db = env.HOSTED_DB;
  if (db === undefined) throw new Error('HOSTED_DB binding missing in test env');
  return db;
}

function admissionEnv(admittedUserIds?: string): Env {
  return {
    ...env,
    HOSTED_WORKOS_CLIENT_ID: HOSTED_CLIENT_ID,
    WORKOS_API_KEY,
    ...(admittedUserIds === undefined ? {} : { HOSTED_ADMITTED_WORKOS_USER_IDS: admittedUserIds }),
  };
}

function identity(userId: string): HostedIdentity {
  return { workosClientId: HOSTED_CLIENT_ID, workosUserId: userId };
}

function waitlistPath(email: string): string {
  const query = new URLSearchParams({
    state: 'approved',
    email: email.trim().toLowerCase(),
    limit: '10',
  });
  return `/user_management/waitlists/default/entries?${query.toString()}`;
}

async function queueWorkOS(
  method: string,
  path: string,
  body: unknown,
  status = 200,
): Promise<void> {
  const response = await fetch(`${WORKOS_API}/__workos-stub/enqueue`, {
    method: 'POST',
    body: JSON.stringify({ method, path, body, status }),
  });
  expect(response.status).toBe(200);
}

async function pendingWorkOSCount(): Promise<number> {
  const response = await fetch(`${WORKOS_API}/__workos-stub/pending`);
  const payload = (await response.json()) as { pending: unknown[] };
  return payload.pending.length;
}

beforeEach(async () => {
  await fetch(`${WORKOS_API}/__workos-stub/reset`, { method: 'POST' });
});

afterEach(async () => {
  expect(await pendingWorkOSCount()).toBe(0);
});

describe('hosted waitlist admission', () => {
  it('persists a first admission only after an exact approved verified email match', async () => {
    const userId = 'user_waitlist_approved';
    const email = 'dev@example.com';
    await queueWorkOS('GET', `/user_management/users/${userId}`, {
      object: 'user',
      id: userId,
      email,
      email_verified: true,
    });
    await queueWorkOS('GET', waitlistPath(email), {
      object: 'list',
      data: [{ email: 'DEV@example.com', state: 'approved' }],
    });

    const admitted = await getOrCreateAdmittedBillingAccount(
      admissionEnv(),
      hostedDb(),
      identity(userId),
    );

    expect(admitted).not.toBeNull();
    expect(admitted?.workos_user_id).toBe(userId);
    expect(await isHostedIdentityAdmitted(admissionEnv(), hostedDb(), identity(userId))).toBe(true);
    expect(await pendingWorkOSCount()).toBe(0);
  });

  it('does not create a billing account for a pending or absent waitlist entry', async () => {
    const userId = 'user_waitlist_pending';
    const email = 'pending@example.com';
    await queueWorkOS('GET', `/user_management/users/${userId}`, {
      object: 'user',
      id: userId,
      email,
      email_verified: true,
    });
    await queueWorkOS('GET', waitlistPath(email), {
      object: 'list',
      data: [{ email, state: 'pending' }],
    });

    expect(
      await getOrCreateAdmittedBillingAccount(admissionEnv(), hostedDb(), identity(userId)),
    ).toBeNull();
    expect(await getBillingAccountByIdentity(hostedDb(), identity(userId))).toBeNull();
  });

  it('does not treat an invitee email at the same domain as the approved email', async () => {
    const userId = 'user_alternate_corporate_email';
    const verifiedEmail = 'alternate@company.example';
    await queueWorkOS('GET', `/user_management/users/${userId}`, {
      object: 'user',
      id: userId,
      email: verifiedEmail,
      email_verified: true,
    });
    // WorkOS can allow organization invitations to be accepted with another
    // address at the same corporate domain. Admission remains an exact-email
    // decision against the verified WorkOS user record.
    await queueWorkOS('GET', waitlistPath(verifiedEmail), {
      object: 'list',
      data: [{ email: 'invited@company.example', state: 'approved' }],
    });

    expect(
      await getOrCreateAdmittedBillingAccount(admissionEnv(), hostedDb(), identity(userId)),
    ).toBeNull();
    expect(await getBillingAccountByIdentity(hostedDb(), identity(userId))).toBeNull();
  });

  it('rejects unverified email without querying the waitlist or creating an account', async () => {
    const userId = 'user_unverified';
    await queueWorkOS('GET', `/user_management/users/${userId}`, {
      object: 'user',
      id: userId,
      email: 'unverified@example.com',
      email_verified: false,
    });

    expect(
      await getOrCreateAdmittedBillingAccount(admissionEnv(), hostedDb(), identity(userId)),
    ).toBeNull();
    expect(await getBillingAccountByIdentity(hostedDb(), identity(userId))).toBeNull();
  });

  it('requires the configured hosted client and does not call WorkOS for a different client', async () => {
    const otherClientIdentity = {
      workosClientId: 'client_anvil_desktop_test',
      workosUserId: 'user_wrong_client',
    };

    expect(
      await getOrCreateAdmittedBillingAccount(admissionEnv(), hostedDb(), otherClientIdentity),
    ).toBeNull();
    expect(await isHostedIdentityAdmitted(admissionEnv(), hostedDb(), otherClientIdentity)).toBe(
      false,
    );
  });

  it('grandfathers an existing active billing account without a WorkOS API call', async () => {
    const admitted = identity('user_grandfathered');
    await getOrCreateBillingAccount(hostedDb(), admitted);

    expect(await isHostedIdentityAdmitted(admissionEnv(), hostedDb(), admitted)).toBe(true);
    expect(await pendingWorkOSCount()).toBe(0);
  });

  it('admits an operator-listed existing user only after fetching a verified WorkOS user', async () => {
    const userId = 'user_operator_reviewed';
    await queueWorkOS('GET', `/user_management/users/${userId}`, {
      object: 'user',
      id: userId,
      email: 'legacy@example.com',
      email_verified: true,
    });

    const admitted = await getOrCreateAdmittedBillingAccount(
      admissionEnv(JSON.stringify([userId])),
      hostedDb(),
      identity(userId),
    );

    expect(admitted?.workos_user_id).toBe(userId);
    // Admission is persisted by the account row, so operators can remove
    // the temporary id override immediately after this succeeds.
    expect(await isHostedIdentityAdmitted(admissionEnv(), hostedDb(), identity(userId))).toBe(true);
    expect(await pendingWorkOSCount()).toBe(0);
  });

  it('does not honor malformed or duplicate operator id lists', async () => {
    const userId = 'user_bad_operator_list';
    const email = 'existing@example.com';
    await queueWorkOS('GET', `/user_management/users/${userId}`, {
      object: 'user',
      id: userId,
      email,
      email_verified: true,
    });
    await queueWorkOS('GET', waitlistPath(email), { object: 'list', data: [] });

    expect(
      await getOrCreateAdmittedBillingAccount(
        admissionEnv(JSON.stringify([userId, userId])),
        hostedDb(),
        identity(userId),
      ),
    ).toBeNull();
    expect(await getBillingAccountByIdentity(hostedDb(), identity(userId))).toBeNull();
  });

  it('fails closed without creating an account when WorkOS is unavailable', async () => {
    const userId = 'user_workos_unavailable';
    await queueWorkOS('GET', `/user_management/users/${userId}`, { error: 'unavailable' }, 503);

    await expect(
      getOrCreateAdmittedBillingAccount(admissionEnv(), hostedDb(), identity(userId)),
    ).rejects.toBeInstanceOf(WorkOSRequestError);
    expect(await getBillingAccountByIdentity(hostedDb(), identity(userId))).toBeNull();
  });
});
