import { env, SELF } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  DeviceListResult,
  DeviceSession,
  EnrollmentCodeIssueResult,
} from '../../contract/auth';
import {
  FREE_TEAM_SEAT_CAPACITY,
  getOrganizationTeamCapacity,
  recordCheckoutSession,
} from '../src/hosted/billing';
import { PREVIEW_END_MS } from '../src/hosted/policy';
import { handleHostedDevices } from '../src/hosted/device-routes';
import type { HostedIdentity } from '../src/hosted/identity';
import {
  assignOrganizationSeat,
  completeHostedInvitationAcceptance,
  ensureOwnerSeatForPaidOrganization,
  handleHostedOrganizationRequest,
  prepareHostedAccountDeletion,
} from '../src/hosted/organizations';
import { withSelfHostedBackend } from './helpers';

const WORKOS_API = 'https://api.workos.com';
const WORKOS_API_KEY = 'sk_test_workos_fake';
const HOSTED_CLIENT_ID = 'client_hosted_test';
const POST_PREVIEW = PREVIEW_END_MS + 30 * 24 * 60 * 60 * 1000;

function hostedDb(): D1Database {
  const db = env.HOSTED_DB;
  if (db === undefined) throw new Error('HOSTED_DB binding missing in test env');
  return db;
}

function testEnv(): Env {
  return {
    ...env,
    HOSTED_WORKOS_CLIENT_ID: HOSTED_CLIENT_ID,
    WORKOS_API_KEY,
  };
}

function id(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
}

function identity(userId: string): HostedIdentity {
  return { workosClientId: HOSTED_CLIENT_ID, workosUserId: userId };
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

async function workosCalls(): Promise<{ method: string; path: string }[]> {
  const response = await fetch(`${WORKOS_API}/__workos-stub/calls`);
  const result = (await response.json()) as { calls: { method: string; path: string }[] };
  return result.calls;
}

async function invoke(
  path: string,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await handleHostedOrganizationRequest(path, body, testEnv(), hostedDb());
  if (response === null) throw new Error(`unhandled organization route ${path}`);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function createBillingAccount(userId: string, email: string): Promise<string> {
  const accountId = id('bill');
  const now = Date.now();
  await hostedDb()
    .prepare(
      `INSERT INTO billing_accounts
         (id, workos_client_id, workos_user_id, sync_account_id, generation, lifecycle,
          preview_eligible, created_at, updated_at)
       VALUES (?, ?, ?, NULL, 1, 'active', 1, ?, ?)`,
    )
    .bind(accountId, HOSTED_CLIENT_ID, userId, now, now)
    .run();
  void email;
  return accountId;
}

async function createActiveOrganization(args: {
  ownerUserId: string;
  ownerAccountId: string;
  organizationId?: string;
  workosOrganizationId?: string;
  ownerMembershipId?: string;
  ownerEmail?: string;
}): Promise<string> {
  const organizationId = args.organizationId ?? id('anvil_org');
  const now = Date.now();
  await hostedDb()
    .prepare(
      `INSERT INTO hosted_organizations
         (id, idempotency_key, workos_organization_id, name, status,
          created_by_workos_user_id, created_at, updated_at)
       VALUES (?, ?, ?, 'Test team', 'active', ?, ?, ?)`,
    )
    .bind(
      organizationId,
      id('idem'),
      args.workosOrganizationId ?? id('org_provider'),
      args.ownerUserId,
      now,
      now,
    )
    .run();
  await hostedDb()
    .prepare(
      `INSERT INTO hosted_organization_memberships
         (organization_id, billing_account_id, workos_client_id, workos_user_id, email,
          workos_membership_id, workos_sync_status, role, status, seat_opted_out, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'synced', 'owner', 'active', 0, ?, ?)`,
    )
    .bind(
      organizationId,
      args.ownerAccountId,
      HOSTED_CLIENT_ID,
      args.ownerUserId,
      args.ownerEmail ?? `${args.ownerUserId}@example.test`,
      args.ownerMembershipId ?? id('mem_provider'),
      now,
      now,
    )
    .run();
  await hostedDb()
    .prepare(
      `INSERT INTO organization_billing_state
         (organization_id, preview_seat_capacity, effective_seat_capacity,
          scheduled_seat_capacity, scheduled_effective_at,
          seat_update_lease_token, seat_update_lease_until, created_at, updated_at)
       VALUES (?, 5, 5, NULL, NULL, NULL, NULL, ?, ?)`,
    )
    .bind(organizationId, now, now)
    .run();
  return organizationId;
}

async function addAssignedMember(
  organizationId: string,
  userId: string,
  accountId: string,
): Promise<void> {
  const now = Date.now();
  await hostedDb()
    .prepare(
      `INSERT INTO hosted_organization_memberships
         (organization_id, billing_account_id, workos_client_id, workos_user_id, email,
          workos_membership_id, workos_sync_status, role, status, seat_opted_out, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'synced', 'member', 'active', 0, ?, ?)`,
    )
    .bind(
      organizationId,
      accountId,
      HOSTED_CLIENT_ID,
      userId,
      `${userId}@example.test`,
      id('mem_provider'),
      now,
      now,
    )
    .run();
  await hostedDb()
    .prepare(
      `INSERT INTO hosted_team_seat_assignments
         (id, organization_id, billing_account_id, invitation_id, state, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, NULL, 'assigned', NULL, ?, ?)`,
    )
    .bind(id('seat'), organizationId, accountId, now, now)
    .run();
}

async function enrollDeviceOnAccount(accountId: string): Promise<DeviceSession> {
  const adminToken = id('admin');
  env.ENROLLMENT_ADMIN_TOKEN = adminToken;
  const issue = await withSelfHostedBackend(() => SELF.fetch('https://spike.test/v1/enrollment-codes', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ accountId }),
  }));
  expect(issue.status).toBe(200);
  const { code } = (await issue.json()) as EnrollmentCodeIssueResult;
  const enrollment = await withSelfHostedBackend(() => SELF.fetch('https://spike.test/v1/enroll', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      proof: { method: 'enrollment-code', code },
      installationId: id('installation'),
      displayName: 'Organization privacy fixture',
    }),
  }));
  expect(enrollment.status).toBe(200);
  return (await enrollment.json()) as DeviceSession;
}

function usersByEmailPath(email: string): string {
  const url = new URL('https://api.workos.com/user_management/users');
  url.searchParams.set('email', email);
  url.searchParams.set('limit', '100');
  return `${url.pathname}${url.search}`;
}

beforeEach(async () => {
  await fetch(`${WORKOS_API}/__workos-stub/reset`, { method: 'POST' });
});

afterEach(async () => {
  await fetch(`${WORKOS_API}/__workos-stub/reset`, { method: 'POST' });
});

describe('hosted organization operations', () => {
  it('creates one WorkOS organization for concurrent retries with the same idempotency key', async () => {
    const ownerUserId = id('user');
    const ownerAccountId = await createBillingAccount(ownerUserId, `${ownerUserId}@example.test`);
    const requestBody = {
      identity: identity(ownerUserId),
      name: 'First team',
      idempotencyKey: id('idem'),
    };
    await queueWorkOS('GET', '/organizations/external_id/*', { message: 'missing' }, 404);
    await queueWorkOS('POST', '/organizations', { id: 'org_provider_created' }, 201);
    await queueWorkOS('GET', `/user_management/users/${ownerUserId}`, {
      id: ownerUserId,
      email: `${ownerUserId}@example.test`,
      email_verified: true,
    });
    await queueWorkOS(
      'GET',
      `/user_management/organization_memberships?organization_id=org_provider_created&user_id=${ownerUserId}`,
      { data: [] },
    );
    await queueWorkOS('POST', '/user_management/organization_memberships', {
      id: 'mem_provider_owner',
      organization_id: 'org_provider_created',
      user_id: ownerUserId,
      status: 'active',
      role_slug: 'admin',
    });

    const results = await Promise.all([
      invoke('/internal/hosted/organization-create', requestBody),
      invoke('/internal/hosted/organization-create', requestBody),
    ]);
    expect(results.some((result) => result.status === 200)).toBe(true);
    expect(results.every((result) => result.status === 200 || result.status === 409)).toBe(true);
    const orgCount = await hostedDb()
      .prepare('SELECT COUNT(*) AS count FROM hosted_organizations WHERE idempotency_key = ?')
      .bind(requestBody.idempotencyKey)
      .first<{ count: number }>();
    expect(orgCount?.count).toBe(1);
    const calls = await workosCalls();
    expect(
      calls.filter((call) => call.method === 'POST' && call.path === '/organizations'),
    ).toHaveLength(1);
    expect(ownerAccountId).toBeTruthy();
  });

  it('allows only one invite to reserve the final team seat under concurrency', async () => {
    const ownerUserId = id('user');
    const ownerAccountId = await createBillingAccount(ownerUserId, `${ownerUserId}@example.test`);
    const organizationId = await createActiveOrganization({ ownerUserId, ownerAccountId });
    const providerOrganizationId = id('org_provider');
    await hostedDb()
      .prepare(
        `INSERT INTO hosted_team_seat_assignments
           (id, organization_id, billing_account_id, invitation_id, state, expires_at, created_at, updated_at)
         VALUES (?, ?, ?, NULL, 'assigned', NULL, ?, ?)`,
      )
      .bind(id('seat'), organizationId, ownerAccountId, Date.now(), Date.now())
      .run();
    for (let index = 0; index < 3; index += 1) {
      const memberUserId = id('user');
      const memberAccountId = await createBillingAccount(
        memberUserId,
        `${memberUserId}@example.test`,
      );
      await addAssignedMember(organizationId, memberUserId, memberAccountId);
    }

    const targetUsers = [id('user'), id('user')];
    const providerInvitationId = id('invite_provider');
    const emails = targetUsers.map((userId) => `${userId}@example.test`);
    const inviteBody = targetUsers.map((targetUserId, index) => ({
      identity: identity(ownerUserId),
      organizationId,
      email: emails[index],
    }));
    for (let index = 0; index < targetUsers.length; index += 1) {
      await createBillingAccount(targetUsers[index]!, emails[index]!);
      await queueWorkOS('GET', usersByEmailPath(emails[index]!), {
        data: [{ id: targetUsers[index], email: emails[index], email_verified: true }],
      });
    }
    await queueWorkOS('POST', '/user_management/invitations', {
      id: providerInvitationId,
      organization_id: providerOrganizationId,
      accept_invitation_url: 'https://authkit.example/invite',
      expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    });
    // The active test org has its own provider ID; the one response is used
    // by the winner, whichever of the two concurrently reserves the seat.
    await hostedDb()
      .prepare('UPDATE hosted_organizations SET workos_organization_id = ? WHERE id = ?')
      .bind(providerOrganizationId, organizationId)
      .run();

    const results = await Promise.all(
      inviteBody.map((body) => invoke('/internal/hosted/organization-invite', body)),
    );
    expect(results.filter((result) => result.status === 200)).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 413).length +
        results.filter((result) => result.status === 200).length,
    ).toBe(2);
    const seatCounts = await hostedDb()
      .prepare(
        `SELECT COUNT(*) AS count FROM hosted_team_seat_assignments
         WHERE organization_id = ? AND state IN ('assigned', 'reserved')`,
      )
      .bind(organizationId)
      .first<{ count: number }>();
    expect(seatCounts?.count).toBe(5);

    const reservedInvitation = await hostedDb()
      .prepare(
        `SELECT id, email, target_workos_user_id, workos_invitation_id, expires_at
         FROM hosted_organization_invitations WHERE organization_id = ? AND state = 'pending'`,
      )
      .bind(organizationId)
      .first<{
        id: string;
        email: string;
        target_workos_user_id: string;
        workos_invitation_id: string;
        expires_at: number;
      }>();
    expect(reservedInvitation?.workos_invitation_id).toBe(providerInvitationId);
    if (reservedInvitation === null) throw new Error('winning invitation missing');
    const token = id('token');
    await queueWorkOS('GET', `/user_management/invitations/by_token/${token}`, {
      id: providerInvitationId,
      email: reservedInvitation.email,
      state: 'accepted',
      organization_id: providerOrganizationId,
      accepted_user_id: reservedInvitation.target_workos_user_id,
      expires_at: new Date(reservedInvitation.expires_at).toISOString(),
    });
    await queueWorkOS(
      'GET',
      `/user_management/organization_memberships?organization_id=${providerOrganizationId}&user_id=${reservedInvitation.target_workos_user_id}`,
      {
        data: [
          {
            id: id('mem_provider'),
            organization_id: providerOrganizationId,
            user_id: reservedInvitation.target_workos_user_id,
            status: 'active',
          },
        ],
      },
    );
    const accepted = await invoke('/internal/hosted/organization-invitation-accept', {
      identity: identity(reservedInvitation.target_workos_user_id),
      invitationToken: token,
    });
    expect(accepted.status).toBe(200);
    expect(accepted.body.accepted).toBe(true);
    const assignedSeat = await hostedDb()
      .prepare('SELECT state FROM hosted_team_seat_assignments WHERE invitation_id = ?')
      .bind(reservedInvitation.id)
      .first<{ state: string }>();
    expect(assignedSeat?.state).toBe('assigned');
    await queueWorkOS('GET', `/user_management/invitations/by_token/${token}`, {
      id: providerInvitationId,
      email: reservedInvitation.email,
      state: 'accepted',
      organization_id: providerOrganizationId,
      accepted_user_id: reservedInvitation.target_workos_user_id,
      expires_at: new Date(reservedInvitation.expires_at).toISOString(),
    });
    const replay = await invoke('/internal/hosted/organization-invitation-accept', {
      identity: identity(reservedInvitation.target_workos_user_id),
      invitationToken: token,
    });
    expect(replay.status).toBe(200);
    expect(replay.body.accepted).toBe(true);
  });

  it('creates, reserves, and accepts a free team seat after the preview deadline', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(POST_PREVIEW);
    try {
      const ownerUserId = id('user');
      const ownerAccountId = await createBillingAccount(ownerUserId, `${ownerUserId}@example.test`);
      const providerOrganizationId = id('org_provider');
      const organizationId = await createActiveOrganization({
        ownerUserId,
        ownerAccountId,
        workosOrganizationId: providerOrganizationId,
      });
      expect(
        await assignOrganizationSeat(hostedDb(), organizationId, ownerAccountId, POST_PREVIEW),
      ).toBe(true);

      const targetUserId = id('user');
      const targetEmail = `${targetUserId}@example.test`;
      const targetAccountId = await createBillingAccount(targetUserId, targetEmail);
      const providerInvitationId = id('invite_provider');
      await queueWorkOS('GET', usersByEmailPath(targetEmail), {
        data: [{ id: targetUserId, email: targetEmail, email_verified: true }],
      });
      await queueWorkOS('POST', '/user_management/invitations', {
        id: providerInvitationId,
        organization_id: providerOrganizationId,
        accept_invitation_url: 'https://authkit.example/free-team-invite',
        expires_at: new Date(POST_PREVIEW + 7 * 24 * 60 * 60 * 1000).toISOString(),
      });

      const invited = await invoke('/internal/hosted/organization-invite', {
        identity: identity(ownerUserId),
        organizationId,
        email: targetEmail,
      });
      expect(invited.status).toBe(200);
      expect(invited.body.seats).toEqual({ assigned: 1, reserved: 1, available: 3 });

      const invitation = await hostedDb()
        .prepare(
          `SELECT id, expires_at FROM hosted_organization_invitations
           WHERE organization_id = ? AND target_workos_user_id = ? AND state = 'pending'`,
        )
        .bind(organizationId, targetUserId)
        .first<{ id: string; expires_at: number }>();
      expect(invitation).not.toBeNull();
      if (invitation === null) throw new Error('free team invitation missing');
      const token = id('token');
      const providerMembershipId = id('mem_provider');
      await queueWorkOS('GET', `/user_management/invitations/by_token/${token}`, {
        id: providerInvitationId,
        email: targetEmail,
        state: 'accepted',
        organization_id: providerOrganizationId,
        accepted_user_id: targetUserId,
        expires_at: new Date(invitation.expires_at).toISOString(),
      });
      await queueWorkOS(
        'GET',
        `/user_management/organization_memberships?organization_id=${providerOrganizationId}&user_id=${targetUserId}`,
        {
          data: [
            {
              id: providerMembershipId,
              organization_id: providerOrganizationId,
              user_id: targetUserId,
              status: 'active',
            },
          ],
        },
      );
      const accepted = await invoke('/internal/hosted/organization-invitation-accept', {
        identity: identity(targetUserId),
        invitationToken: token,
      });
      expect(accepted.status).toBe(200);
      expect(accepted.body.accepted).toBe(true);

      const seat = await hostedDb()
        .prepare('SELECT state FROM hosted_team_seat_assignments WHERE invitation_id = ?')
        .bind(invitation.id)
        .first<{ state: string }>();
      expect(seat?.state).toBe('assigned');
      expect(await getOrganizationTeamCapacity(hostedDb(), organizationId, POST_PREVIEW)).toBe(
        FREE_TEAM_SEAT_CAPACITY,
      );
      const subscription = await hostedDb()
        .prepare('SELECT COUNT(*) AS count FROM stripe_subscriptions WHERE organization_id = ?')
        .bind(organizationId)
        .first<{ count: number }>();
      expect(subscription?.count).toBe(0);
      expect(targetAccountId).toBeTruthy();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('does not convert an expired seat reservation during invitation acceptance', async () => {
    const ownerUserId = id('user');
    const targetUserId = id('user');
    const ownerAccountId = await createBillingAccount(ownerUserId, `${ownerUserId}@example.test`);
    const targetAccountId = await createBillingAccount(
      targetUserId,
      `${targetUserId}@example.test`,
    );
    const organizationId = await createActiveOrganization({
      ownerUserId,
      ownerAccountId,
    });
    const invitationId = id('inv');
    const now = Date.now();
    const targetEmail = `${targetUserId}@example.test`;
    await hostedDb()
      .prepare(
        `INSERT INTO hosted_organization_invitations
           (id, organization_id, target_billing_account_id, target_workos_user_id, email,
            invited_by_workos_user_id, workos_invitation_id, state, expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      )
      .bind(
        invitationId,
        organizationId,
        targetAccountId,
        targetUserId,
        targetEmail,
        ownerUserId,
        id('provider_inv'),
        now + 24 * 60 * 60 * 1000,
        now,
        now,
      )
      .run();
    await hostedDb()
      .prepare(
        `INSERT INTO hosted_team_seat_assignments
           (id, organization_id, billing_account_id, invitation_id, state, expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'reserved', ?, ?, ?)`,
      )
      .bind(id('seat'), organizationId, targetAccountId, invitationId, now - 1, now, now)
      .run();

    const accepted = await completeHostedInvitationAcceptance(hostedDb(), {
      invitationId,
      organizationId,
      billingAccountId: targetAccountId,
      workosUserId: targetUserId,
      email: targetEmail,
      providerMembershipId: id('provider_mem'),
      now,
    });
    expect(accepted).toBe(false);
    const membership = await hostedDb()
      .prepare(
        `SELECT status FROM hosted_organization_memberships
         WHERE organization_id = ? AND workos_user_id = ?`,
      )
      .bind(organizationId, targetUserId)
      .first<{ status: string }>();
    const invitationState = await hostedDb()
      .prepare('SELECT state FROM hosted_organization_invitations WHERE id = ?')
      .bind(invitationId)
      .first<{ state: string }>();
    expect(membership).toBeNull();
    expect(invitationState?.state).toBe('pending');
  });

  it('keeps a billing-only owner opted out after payment and supports explicit seat opt-in', async () => {
    const ownerUserId = id('user');
    const ownerAccountId = await createBillingAccount(ownerUserId, `${ownerUserId}@example.test`);
    const providerOrganizationId = id('org_provider');
    const requestBody = {
      identity: identity(ownerUserId),
      name: 'Billing only team',
      idempotencyKey: id('idem'),
      ownerSeatAssigned: false,
    };
    await queueWorkOS('GET', '/organizations/external_id/*', { message: 'missing' }, 404);
    await queueWorkOS('POST', '/organizations', { id: providerOrganizationId }, 201);
    await queueWorkOS('GET', `/user_management/users/${ownerUserId}`, {
      id: ownerUserId,
      email: `${ownerUserId}@example.test`,
      email_verified: true,
    });
    await queueWorkOS(
      'GET',
      `/user_management/organization_memberships?organization_id=${providerOrganizationId}&user_id=${ownerUserId}`,
      { data: [] },
    );
    await queueWorkOS('POST', '/user_management/organization_memberships', {
      id: id('mem_provider'),
      organization_id: providerOrganizationId,
      user_id: ownerUserId,
      status: 'active',
      role_slug: 'admin',
    });
    const created = await invoke('/internal/hosted/organization-create', requestBody);
    expect(created.status).toBe(200);
    const view = created.body.organization as { id: string; membership: { seatAssigned: boolean } };
    expect(view.membership.seatAssigned).toBe(false);
    const optOut = await hostedDb()
      .prepare(
        `SELECT seat_opted_out FROM hosted_organization_memberships
         WHERE organization_id = ? AND workos_user_id = ?`,
      )
      .bind(view.id, ownerUserId)
      .first<{ seat_opted_out: number }>();
    expect(optOut?.seat_opted_out).toBe(1);

    const now = Date.now();
    await hostedDb()
      .prepare(
        `INSERT INTO stripe_subscriptions
           (stripe_subscription_id, stripe_customer_id, billing_account_id, organization_id,
            stripe_subscription_item_id, seat_quantity, paid_seat_quantity, status, plan_key, interval,
            current_period_end, paid_through, cancel_at_period_end, has_paid_invoice, first_failed_renewal_at,
            verified_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 5, 5, 'active', 'sync_team', 'month', ?, ?, 0, 1, NULL, ?, ?, ?)`,
      )
      .bind(
        id('sub'),
        id('cus'),
        ownerAccountId,
        view.id,
        id('si'),
        now + 10 * 24 * 60 * 60 * 1000,
        now + 10 * 24 * 60 * 60 * 1000,
        now,
        now,
        now,
      )
      .run();
    await ensureOwnerSeatForPaidOrganization(hostedDb(), view.id, now);
    const seatCount = await hostedDb()
      .prepare(
        "SELECT COUNT(*) AS count FROM hosted_team_seat_assignments WHERE organization_id = ? AND state = 'assigned'",
      )
      .bind(view.id)
      .first<{ count: number }>();
    expect(seatCount?.count).toBe(0);

    const optedIn = await invoke('/internal/hosted/organization-member-seat', {
      identity: identity(ownerUserId),
      organizationId: view.id,
      workosUserId: ownerUserId,
      assigned: true,
    });
    expect(optedIn.status).toBe(200);
    const afterOptIn = await hostedDb()
      .prepare(
        `SELECT seat_opted_out FROM hosted_organization_memberships
         WHERE organization_id = ? AND workos_user_id = ?`,
      )
      .bind(view.id, ownerUserId)
      .first<{ seat_opted_out: number }>();
    expect(afterOptIn?.seat_opted_out).toBe(0);
    const finalSeatCount = await hostedDb()
      .prepare(
        "SELECT COUNT(*) AS count FROM hosted_team_seat_assignments WHERE organization_id = ? AND state = 'assigned'",
      )
      .bind(view.id)
      .first<{ count: number }>();
    expect(finalSeatCount?.count).toBe(1);
  });

  it('blocks owner closure while team billing is live, then closes after cancellation', async () => {
    const ownerUserId = id('user');
    const ownerAccountId = await createBillingAccount(ownerUserId, `${ownerUserId}@example.test`);
    const ownerMembershipId = id('mem_provider');
    const providerOrganizationId = id('org_provider');
    const organizationId = await createActiveOrganization({
      ownerUserId,
      ownerAccountId,
      ownerMembershipId,
      workosOrganizationId: providerOrganizationId,
    });
    const now = Date.now();
    await hostedDb()
      .prepare(
        `INSERT INTO stripe_subscriptions
           (stripe_subscription_id, stripe_customer_id, billing_account_id, organization_id,
            stripe_subscription_item_id, seat_quantity, paid_seat_quantity, status, plan_key, interval,
            current_period_end, paid_through, cancel_at_period_end, has_paid_invoice, first_failed_renewal_at,
            verified_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 5, 5, 'active', 'sync_team', 'month', ?, ?, 0, 1, NULL, ?, ?, ?)`,
      )
      .bind(
        id('sub'),
        id('cus'),
        ownerAccountId,
        organizationId,
        id('si'),
        now + 10 * 24 * 60 * 60 * 1000,
        now + 10 * 24 * 60 * 60 * 1000,
        now,
        now,
        now,
      )
      .run();
    await hostedDb()
      .prepare(
        `INSERT INTO hosted_team_seat_assignments
           (id, organization_id, billing_account_id, invitation_id, state, expires_at, created_at, updated_at)
         VALUES (?, ?, ?, NULL, 'assigned', NULL, ?, ?)`,
      )
      .bind(id('seat'), organizationId, ownerAccountId, now, now)
      .run();

    const closeRequest = {
      identity: identity(ownerUserId),
      organizationId,
    };
    const blocked = await invoke('/internal/hosted/organization-close', closeRequest);
    expect(blocked.status).toBe(409);
    expect((blocked.body.error as { details?: { reason?: string } }).details?.reason).toBe(
      'team-subscription-active',
    );
    const remainsActive = await hostedDb()
      .prepare('SELECT status FROM hosted_organizations WHERE id = ?')
      .bind(organizationId)
      .first<{ status: string }>();
    expect(remainsActive?.status).toBe('active');

    await hostedDb()
      .prepare(
        "UPDATE stripe_subscriptions SET status = 'canceled', verified_at = ? WHERE organization_id = ?",
      )
      .bind(Date.now(), organizationId)
      .run();
    await queueWorkOS(
      'PUT',
      `/user_management/organization_memberships/${ownerMembershipId}/deactivate`,
      {},
    );
    const closed = await invoke('/internal/hosted/organization-close', closeRequest);
    expect(closed.status).toBe(200);
    expect(closed.body.closed).toBe(true);
    const closedState = await hostedDb()
      .prepare(
        `SELECT o.status, m.status AS membership_status, s.state AS seat_state
         FROM hosted_organizations o
         JOIN hosted_organization_memberships m ON m.organization_id = o.id
         JOIN hosted_team_seat_assignments s ON s.organization_id = o.id
         WHERE o.id = ? ORDER BY s.created_at DESC LIMIT 1`,
      )
      .bind(organizationId)
      .first<{ status: string; membership_status: string; seat_state: string }>();
    expect(closedState).toEqual({
      status: 'closed',
      membership_status: 'inactive',
      seat_state: 'released',
    });
  });

  it('serializes organization closure against team checkout creation', async () => {
    const ownerUserId = id('user');
    const ownerAccountId = await createBillingAccount(ownerUserId, `${ownerUserId}@example.test`);
    const organizationId = await createActiveOrganization({ ownerUserId, ownerAccountId });
    const closeRequest = { identity: identity(ownerUserId), organizationId };
    const checkoutId = id('checkout');
    const now = Date.now();

    const [closed, checkoutRecorded] = await Promise.all([
      invoke('/internal/hosted/organization-close', closeRequest),
      recordCheckoutSession(
        hostedDb(),
        checkoutId,
        ownerAccountId,
        'sync_team',
        'month',
        now,
        organizationId,
        5,
      ),
    ]);
    const state = await hostedDb()
      .prepare(
        `SELECT o.status,
                EXISTS (SELECT 1 FROM checkout_sessions cs
                        WHERE cs.organization_id = o.id AND cs.status = 'open') AS open_checkout
         FROM hosted_organizations o WHERE o.id = ?`,
      )
      .bind(organizationId)
      .first<{ status: string; open_checkout: number }>();

    if (closed.status === 200) {
      expect(checkoutRecorded).toBe(false);
      expect(state).toEqual({ status: 'closed', open_checkout: 0 });
    } else {
      expect(closed.status).toBe(409);
      expect(checkoutRecorded).toBe(true);
      expect(state).toEqual({ status: 'active', open_checkout: 1 });
    }
  });

  it('serializes concurrent last-owner account deletions without partial changes', async () => {
    const firstUserId = id('user');
    const secondUserId = id('user');
    const firstAccountId = await createBillingAccount(firstUserId, `${firstUserId}@example.test`);
    const secondAccountId = await createBillingAccount(
      secondUserId,
      `${secondUserId}@example.test`,
    );
    const organizationId = await createActiveOrganization({
      ownerUserId: firstUserId,
      ownerAccountId: firstAccountId,
    });
    const now = Date.now();
    await hostedDb()
      .prepare(
        `INSERT INTO hosted_organization_memberships
           (organization_id, billing_account_id, workos_client_id, workos_user_id, email,
            workos_membership_id, workos_sync_status, role, status, seat_opted_out, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'synced', 'owner', 'active', 0, ?, ?)`,
      )
      .bind(
        organizationId,
        secondAccountId,
        HOSTED_CLIENT_ID,
        secondUserId,
        `${secondUserId}@example.test`,
        id('mem_provider'),
        now,
        now,
      )
      .run();

    const results = await Promise.all([
      prepareHostedAccountDeletion(hostedDb(), firstAccountId, now),
      prepareHostedAccountDeletion(hostedDb(), secondAccountId, now),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const activeOwners = await hostedDb()
      .prepare(
        `SELECT COUNT(*) AS count FROM hosted_organization_memberships
         WHERE organization_id = ? AND status = 'active' AND role = 'owner'`,
      )
      .bind(organizationId)
      .first<{ count: number }>();
    expect(activeOwners?.count).toBe(1);
  });

  it('retains the last closed-org billing owner until the subscription is terminal', async () => {
    const ownerUserId = id('user');
    const ownerAccountId = await createBillingAccount(ownerUserId, `${ownerUserId}@example.test`);
    const organizationId = await createActiveOrganization({
      ownerUserId,
      ownerAccountId,
    });
    const now = Date.now();
    await hostedDb()
      .prepare("UPDATE hosted_organizations SET status = 'closed' WHERE id = ?")
      .bind(organizationId)
      .run();
    await hostedDb()
      .prepare(
        `INSERT INTO stripe_subscriptions
           (stripe_subscription_id, stripe_customer_id, billing_account_id, organization_id,
            stripe_subscription_item_id, seat_quantity, paid_seat_quantity, status, plan_key, interval,
            current_period_end, paid_through, cancel_at_period_end, has_paid_invoice, first_failed_renewal_at,
            verified_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 5, 5, 'past_due', 'sync_team', 'month', ?, ?, 0, 1, NULL, ?, ?, ?)`,
      )
      .bind(
        id('sub'),
        id('cus'),
        ownerAccountId,
        organizationId,
        id('si'),
        now + 10 * 24 * 60 * 60 * 1000,
        now - 1,
        now,
        now,
        now,
      )
      .run();

    expect(await prepareHostedAccountDeletion(hostedDb(), ownerAccountId, now)).toBe(false);
    await hostedDb()
      .prepare("UPDATE stripe_subscriptions SET status = 'canceled' WHERE organization_id = ?")
      .bind(organizationId)
      .run();
    expect(await prepareHostedAccountDeletion(hostedDb(), ownerAccountId, now)).toBe(true);
    const membership = await hostedDb()
      .prepare(
        `SELECT status FROM hosted_organization_memberships
         WHERE organization_id = ? AND workos_user_id = ?`,
      )
      .bind(organizationId, ownerUserId)
      .first<{ status: string }>();
    expect(membership?.status).toBe('inactive');
  });

  it('serializes concurrent owner demotions and always preserves one active owner', async () => {
    const firstUserId = id('user');
    const secondUserId = id('user');
    const firstAccountId = await createBillingAccount(firstUserId, `${firstUserId}@example.test`);
    const secondAccountId = await createBillingAccount(
      secondUserId,
      `${secondUserId}@example.test`,
    );
    const firstMembershipId = id('mem_provider');
    const secondMembershipId = id('mem_provider');
    const organizationId = await createActiveOrganization({
      ownerUserId: firstUserId,
      ownerAccountId: firstAccountId,
      ownerMembershipId: firstMembershipId,
    });
    const now = Date.now();
    await hostedDb()
      .prepare(
        `INSERT INTO hosted_organization_memberships
           (organization_id, billing_account_id, workos_client_id, workos_user_id, email,
            workos_membership_id, workos_sync_status, role, status, seat_opted_out, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'synced', 'owner', 'active', 0, ?, ?)`,
      )
      .bind(
        organizationId,
        secondAccountId,
        HOSTED_CLIENT_ID,
        secondUserId,
        `${secondUserId}@example.test`,
        secondMembershipId,
        now,
        now,
      )
      .run();
    await queueWorkOS('PUT', `/user_management/organization_memberships/${firstMembershipId}`, {
      role_slug: 'member',
    });
    await queueWorkOS('PUT', `/user_management/organization_memberships/${secondMembershipId}`, {
      role_slug: 'member',
    });

    const results = await Promise.all([
      invoke('/internal/hosted/organization-role', {
        identity: identity(firstUserId),
        organizationId,
        workosUserId: firstUserId,
        role: 'member',
      }),
      invoke('/internal/hosted/organization-role', {
        identity: identity(firstUserId),
        organizationId,
        workosUserId: secondUserId,
        role: 'member',
      }),
    ]);
    expect(results.filter((result) => result.status === 200)).toHaveLength(1);
    expect(results.some((result) => result.status === 403 || result.status === 409)).toBe(true);
    const activeOwners = await hostedDb()
      .prepare(
        `SELECT COUNT(*) AS count FROM hosted_organization_memberships
         WHERE organization_id = ? AND status = 'active' AND role = 'owner'`,
      )
      .bind(organizationId)
      .first<{ count: number }>();
    expect(activeOwners?.count).toBe(1);
  });

  it('keeps personal sync data private and scopes device actions to the caller account', async () => {
    const ownerUserId = id('user');
    const memberUserId = id('user');
    const ownerAccountId = await createBillingAccount(ownerUserId, `${ownerUserId}@example.test`);
    const memberAccountId = await createBillingAccount(
      memberUserId,
      `${memberUserId}@example.test`,
    );
    const ownerSyncAccountId = id('sync_owner');
    const memberSyncAccountId = id('sync_member');
    await hostedDb()
      .prepare('UPDATE billing_accounts SET sync_account_id = ? WHERE id = ?')
      .bind(ownerSyncAccountId, ownerAccountId)
      .run();
    await hostedDb()
      .prepare('UPDATE billing_accounts SET sync_account_id = ? WHERE id = ?')
      .bind(memberSyncAccountId, memberAccountId)
      .run();
    const organizationId = await createActiveOrganization({ ownerUserId, ownerAccountId });
    await addAssignedMember(organizationId, memberUserId, memberAccountId);
    const memberDevice = await enrollDeviceOnAccount(memberSyncAccountId);
    expect(memberDevice.accountId).toBe(memberSyncAccountId);

    const ownerDevices = await handleHostedDevices(
      {
        ...identity(ownerUserId),
        organizationId,
        targetWorkosUserId: memberUserId,
        syncAccountId: memberSyncAccountId,
      },
      testEnv(),
      hostedDb(),
    );
    expect(ownerDevices.status).toBe(200);
    const ownerDeviceResult = (await ownerDevices.json()) as DeviceListResult;
    expect(ownerDeviceResult.devices).toHaveLength(0);
    const memberDevices = await handleHostedDevices(identity(memberUserId), testEnv(), hostedDb());
    expect(((await memberDevices.json()) as DeviceListResult).devices).toHaveLength(1);

    const organizationList = await invoke('/internal/hosted/organizations', {
      identity: identity(ownerUserId),
      organizationId,
      workosUserId: memberUserId,
      syncAccountId: memberSyncAccountId,
    });
    expect(organizationList.status).toBe(200);
    const serializedView = JSON.stringify(organizationList.body);
    expect(serializedView).not.toContain(ownerSyncAccountId);
    expect(serializedView).not.toContain(memberSyncAccountId);
    expect(serializedView).not.toMatch(/devices|workers|content|syncAccountId/i);
    const rows = await hostedDb()
      .prepare('SELECT id, sync_account_id FROM billing_accounts WHERE id IN (?, ?) ORDER BY id')
      .bind(ownerAccountId, memberAccountId)
      .all<{ id: string; sync_account_id: string }>();
    expect(rows.results?.map((row) => row.sync_account_id).sort()).toEqual(
      [ownerSyncAccountId, memberSyncAccountId].sort(),
    );
  });

  it('rejects an accepted same-domain invitation when WorkOS accepted it for another user', async () => {
    const targetUserId = id('user');
    const alternateUserId = id('user');
    const providerOrganizationId = id('org_provider');
    const ownerUserId = id('user');
    const ownerAccountId = await createBillingAccount(ownerUserId, `${ownerUserId}@company.test`);
    const targetAccountId = await createBillingAccount(
      targetUserId,
      `${targetUserId}@company.test`,
    );
    await createBillingAccount(alternateUserId, `${alternateUserId}@company.test`);
    const organizationId = await createActiveOrganization({
      ownerUserId,
      ownerAccountId,
    });
    const invitationId = id('inv');
    const now = Date.now();
    await hostedDb()
      .prepare(
        `INSERT INTO hosted_organization_invitations
           (id, organization_id, target_billing_account_id, target_workos_user_id, email,
            invited_by_workos_user_id, workos_invitation_id, state, workos_sync_status,
            expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 'synced', ?, ?, ?)`,
      )
      .bind(
        invitationId,
        organizationId,
        targetAccountId,
        targetUserId,
        'invited@company.test',
        targetUserId,
        'invite_provider_alternate',
        now + 60_000,
        now,
        now,
      )
      .run();
    await hostedDb()
      .prepare(
        `INSERT INTO hosted_team_seat_assignments
           (id, organization_id, billing_account_id, invitation_id, state, expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'reserved', ?, ?, ?)`,
      )
      .bind(id('seat'), organizationId, targetAccountId, invitationId, now + 60_000, now, now)
      .run();
    await queueWorkOS('GET', '/user_management/invitations/by_token/token_for_other_user', {
      id: 'invite_provider_alternate',
      email: 'invited@company.test',
      state: 'accepted',
      organization_id: providerOrganizationId,
      accepted_user_id: alternateUserId,
      expires_at: new Date(now + 60_000).toISOString(),
    });
    await hostedDb()
      .prepare('UPDATE hosted_organizations SET workos_organization_id = ? WHERE id = ?')
      .bind(providerOrganizationId, organizationId)
      .run();
    const result = await invoke('/internal/hosted/organization-invitation-accept', {
      identity: identity(targetUserId),
      invitationToken: 'token_for_other_user',
    });
    expect(result.status).toBe(403);
    const member = await hostedDb()
      .prepare(
        'SELECT status FROM hosted_organization_memberships WHERE organization_id = ? AND workos_user_id = ?',
      )
      .bind(organizationId, targetUserId)
      .first();
    expect(member).toBeNull();
    const reservation = await hostedDb()
      .prepare('SELECT state FROM hosted_team_seat_assignments WHERE invitation_id = ?')
      .bind(invitationId)
      .first<{ state: string }>();
    expect(reservation?.state).toBe('reserved');
  });
});
