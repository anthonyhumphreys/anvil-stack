import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  handleHostedOrganizationWebhook,
  runHostedOrganizationReconcile,
} from '../src/hosted/organization-webhooks';

const WORKOS_API = 'https://api.workos.com';
const WORKOS_API_KEY = 'sk_test_workos_fake';
const WORKOS_WEBHOOK_SECRET = 'whsec_test_workos_fake0123456789';
const HOSTED_CLIENT_ID = 'client_hosted_test';

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
    WORKOS_WEBHOOK_SECRET,
  };
}

function id(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
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

async function signBody(rawBody: string, timestamp = Date.now()): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(WORKOS_WEBHOOK_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signed = new TextEncoder().encode(`${timestamp}.${rawBody}`);
  const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, signed));
  const signature = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `t=${timestamp},v1=${signature}`;
}

async function sendEvent(
  event: string,
  data: Record<string, unknown>,
  eventId = id('event'),
  signatureOverride?: string,
): Promise<{ response: Response; eventId: string }> {
  const rawBody = JSON.stringify({ id: eventId, event, data });
  const signature = signatureOverride ?? (await signBody(rawBody));
  const response = await handleHostedOrganizationWebhook(
    new Request('https://api.anvil.test/v1/hosted/workos-webhook', {
      method: 'POST',
      headers: { 'workos-signature': signature, 'content-type': 'application/json' },
      body: rawBody,
    }),
    testEnv(),
    hostedDb(),
  );
  return { response, eventId };
}

async function createAccount(userId: string): Promise<string> {
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
  return accountId;
}

async function createOrganizationFixture(
  options: {
    ownerRole?: 'owner' | 'member';
    ownerStatus?: 'active' | 'inactive';
    ownerMembershipId?: string | null;
    ownerSeat?: boolean;
    previewCapacity?: number;
    effectiveCapacity?: number;
  } = {},
): Promise<{
  organizationId: string;
  workosOrganizationId: string;
  ownerUserId: string;
  ownerAccountId: string;
  ownerMembershipId: string | null;
}> {
  const db = hostedDb();
  const now = Date.now();
  const organizationId = id('anvil_org');
  const workosOrganizationId = id('org');
  const ownerUserId = id('user');
  const ownerAccountId = await createAccount(ownerUserId);
  const ownerMembershipId =
    options.ownerMembershipId === undefined ? id('omem') : options.ownerMembershipId;
  await db
    .prepare(
      `INSERT INTO hosted_organizations
         (id, idempotency_key, workos_organization_id, name, status,
          created_by_workos_user_id, created_at, updated_at)
       VALUES (?, ?, ?, 'Test team', 'active', ?, ?, ?)`,
    )
    .bind(organizationId, id('idem'), workosOrganizationId, ownerUserId, now, now)
    .run();
  await db
    .prepare(
      `INSERT INTO organization_billing_state
         (organization_id, preview_seat_capacity, effective_seat_capacity, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(organizationId, options.previewCapacity ?? 5, options.effectiveCapacity ?? 5, now, now)
    .run();
  await db
    .prepare(
      `INSERT INTO hosted_organization_memberships
         (organization_id, billing_account_id, workos_client_id, workos_user_id, email,
          workos_membership_id, role, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      organizationId,
      ownerAccountId,
      HOSTED_CLIENT_ID,
      ownerUserId,
      `${ownerUserId}@example.test`,
      ownerMembershipId,
      options.ownerRole ?? 'owner',
      options.ownerStatus ?? 'active',
      now,
      now,
    )
    .run();
  if ((options.ownerSeat ?? true) && options.ownerStatus !== 'inactive') {
    await db
      .prepare(
        `INSERT INTO hosted_team_seat_assignments
           (id, organization_id, billing_account_id, state, created_at, updated_at)
         VALUES (?, ?, ?, 'assigned', ?, ?)`,
      )
      .bind(id('seat'), organizationId, ownerAccountId, now, now)
      .run();
  }
  return {
    organizationId,
    workosOrganizationId,
    ownerUserId,
    ownerAccountId,
    ownerMembershipId,
  };
}

async function isolateReconcileOrganization(organizationId: string): Promise<void> {
  await hostedDb().batch([
    hostedDb()
      .prepare("UPDATE hosted_organizations SET status = 'closed' WHERE id != ?")
      .bind(organizationId),
    hostedDb()
      .prepare(
        `UPDATE hosted_organization_memberships SET workos_sync_status = 'synced'
         WHERE organization_id != ?`,
      )
      .bind(organizationId),
    hostedDb()
      .prepare(
        `UPDATE hosted_organization_invitations SET workos_sync_status = 'synced'
         WHERE organization_id != ?`,
      )
      .bind(organizationId),
  ]);
}

beforeEach(async () => {
  await fetch(`${WORKOS_API}/__workos-stub/reset`, { method: 'POST' });
});

afterEach(async () => {
  await fetch(`${WORKOS_API}/__workos-stub/reset`, { method: 'POST' });
});

describe('hosted WorkOS organization webhooks', () => {
  it('rejects an invalid signature before any provider or database mutation', async () => {
    const fixture = await createOrganizationFixture();
    const { response } = await sendEvent(
      'organization_membership.deleted',
      {
        id: fixture.ownerMembershipId,
        organization_id: fixture.workosOrganizationId,
        user_id: fixture.ownerUserId,
      },
      id('event'),
      `t=${Date.now()},v1=${'0'.repeat(64)}`,
    );
    expect(response.status).toBe(401);
    expect(await workosCalls()).toEqual([]);
    const owner = await hostedDb()
      .prepare(
        `SELECT status FROM hosted_organization_memberships
         WHERE organization_id = ? AND workos_user_id = ?`,
      )
      .bind(fixture.organizationId, fixture.ownerUserId)
      .first<{ status: string }>();
    expect(owner?.status).toBe('active');
  });

  it('releases local sponsorship when WorkOS now returns membership 404', async () => {
    const fixture = await createOrganizationFixture();
    await queueWorkOS(
      'GET',
      `/user_management/organization_memberships/${fixture.ownerMembershipId}`,
      { error: 'not found' },
      404,
    );
    await queueWorkOS('GET', `/organizations/${fixture.workosOrganizationId}`, {
      id: fixture.workosOrganizationId,
    });
    const eventId = id('event');
    const { response } = await sendEvent(
      'organization_membership.deleted',
      {
        id: fixture.ownerMembershipId,
        organization_id: fixture.workosOrganizationId,
        user_id: fixture.ownerUserId,
      },
      eventId,
    );
    expect(response.status).toBe(200);
    const local = await hostedDb()
      .prepare(
        `SELECT status, workos_sync_status FROM hosted_organization_memberships
         WHERE organization_id = ? AND workos_user_id = ?`,
      )
      .bind(fixture.organizationId, fixture.ownerUserId)
      .first<{ status: string; workos_sync_status: string }>();
    expect(local).toEqual({ status: 'inactive', workos_sync_status: 'synced' });
    const seat = await hostedDb()
      .prepare('SELECT state FROM hosted_team_seat_assignments WHERE organization_id = ?')
      .bind(fixture.organizationId)
      .first<{ state: string }>();
    expect(seat?.state).toBe('released');
    const duplicate = await sendEvent(
      'organization_membership.deleted',
      {
        id: fixture.ownerMembershipId,
        organization_id: fixture.workosOrganizationId,
        user_id: fixture.ownerUserId,
      },
      eventId,
    );
    expect(await duplicate.response.json()).toEqual({ received: true, duplicate: true });
    expect((await workosCalls()).length).toBe(2);
  });

  it('preserves billing recovery when membership deletion arrives after whole-org deletion', async () => {
    const fixture = await createOrganizationFixture();
    await queueWorkOS(
      'GET',
      `/organizations/${fixture.workosOrganizationId}`,
      {
        error: 'not found',
      },
      404,
    );
    const deleted = await sendEvent('organization.deleted', {
      id: fixture.workosOrganizationId,
    });
    expect(deleted.response.status).toBe(200);

    await queueWorkOS(
      'GET',
      `/user_management/organization_memberships/${fixture.ownerMembershipId}`,
      { error: 'not found' },
      404,
    );
    await queueWorkOS(
      'GET',
      `/organizations/${fixture.workosOrganizationId}`,
      {
        error: 'not found',
      },
      404,
    );
    const membershipDeleted = await sendEvent('organization_membership.deleted', {
      id: fixture.ownerMembershipId,
      organization_id: fixture.workosOrganizationId,
      user_id: fixture.ownerUserId,
    });
    expect(membershipDeleted.response.status).toBe(200);

    const owner = await hostedDb()
      .prepare(
        `SELECT status, role, seat_opted_out, workos_membership_id
         FROM hosted_organization_memberships WHERE organization_id = ? AND workos_user_id = ?`,
      )
      .bind(fixture.organizationId, fixture.ownerUserId)
      .first<{
        status: string;
        role: string;
        seat_opted_out: number;
        workos_membership_id: string | null;
      }>();
    expect(owner).toEqual({
      status: 'active',
      role: 'owner',
      seat_opted_out: 1,
      workos_membership_id: null,
    });
    const seat = await hostedDb()
      .prepare('SELECT state FROM hosted_team_seat_assignments WHERE organization_id = ?')
      .bind(fixture.organizationId)
      .first<{ state: string }>();
    expect(seat?.state).toBe('released');
  });

  it('ignores an out-of-order delete event when WorkOS confirms the membership is active again', async () => {
    const fixture = await createOrganizationFixture();
    await queueWorkOS(
      'GET',
      `/user_management/organization_memberships/${fixture.ownerMembershipId}`,
      {
        id: fixture.ownerMembershipId,
        organization_id: fixture.workosOrganizationId,
        user_id: fixture.ownerUserId,
        status: 'active',
        role: { slug: 'admin' },
      },
    );

    const { response } = await sendEvent('organization_membership.deleted', {
      id: fixture.ownerMembershipId,
      organization_id: fixture.workosOrganizationId,
      user_id: fixture.ownerUserId,
    });

    expect(response.status).toBe(200);
    const local = await hostedDb()
      .prepare(
        `SELECT status, workos_sync_status FROM hosted_organization_memberships
         WHERE organization_id = ? AND workos_user_id = ?`,
      )
      .bind(fixture.organizationId, fixture.ownerUserId)
      .first<{ status: string; workos_sync_status: string }>();
    expect(local).toEqual({ status: 'active', workos_sync_status: 'synced' });
    const seat = await hostedDb()
      .prepare('SELECT state FROM hosted_team_seat_assignments WHERE organization_id = ?')
      .bind(fixture.organizationId)
      .first<{ state: string }>();
    expect(seat?.state).toBe('assigned');
  });

  it('keeps failed provider deactivation pending and releases the seat until a retry confirms removal', async () => {
    const fixture = await createOrganizationFixture({ ownerStatus: 'inactive' });
    const now = Date.now();
    await hostedDb()
      .prepare(
        `INSERT INTO hosted_team_seat_assignments
           (id, organization_id, billing_account_id, state, created_at, updated_at)
         VALUES (?, ?, ?, 'assigned', ?, ?)`,
      )
      .bind(id('seat'), fixture.organizationId, fixture.ownerAccountId, now, now)
      .run();
    const providerMembership = {
      id: fixture.ownerMembershipId,
      organization_id: fixture.workosOrganizationId,
      user_id: fixture.ownerUserId,
      status: 'active',
      role: { slug: 'admin' },
    };
    const eventId = id('event');
    await queueWorkOS(
      'GET',
      `/user_management/organization_memberships/${fixture.ownerMembershipId}`,
      providerMembership,
    );
    await queueWorkOS(
      'PUT',
      `/user_management/organization_memberships/${fixture.ownerMembershipId}/deactivate`,
      { error: 'temporary failure' },
      500,
    );
    const first = await sendEvent(
      'organization_membership.updated',
      {
        id: fixture.ownerMembershipId,
        organization_id: fixture.workosOrganizationId,
        user_id: fixture.ownerUserId,
      },
      eventId,
    );
    expect(first.response.status).toBe(503);
    const pending = await hostedDb()
      .prepare(
        `SELECT status, workos_sync_status FROM hosted_organization_memberships
         WHERE organization_id = ? AND workos_user_id = ?`,
      )
      .bind(fixture.organizationId, fixture.ownerUserId)
      .first<{ status: string; workos_sync_status: string }>();
    expect(pending).toEqual({ status: 'inactive', workos_sync_status: 'pending' });
    const releasedSeat = await hostedDb()
      .prepare('SELECT state FROM hosted_team_seat_assignments WHERE organization_id = ?')
      .bind(fixture.organizationId)
      .first<{ state: string }>();
    expect(releasedSeat?.state).toBe('released');

    await queueWorkOS(
      'GET',
      `/user_management/organization_memberships/${fixture.ownerMembershipId}`,
      { ...providerMembership, status: 'inactive' },
    );
    const retry = await sendEvent(
      'organization_membership.updated',
      {
        id: fixture.ownerMembershipId,
        organization_id: fixture.workosOrganizationId,
        user_id: fixture.ownerUserId,
      },
      eventId,
    );
    expect(retry.response.status).toBe(200);
    const synced = await hostedDb()
      .prepare(
        `SELECT status, workos_sync_status FROM hosted_organization_memberships
         WHERE organization_id = ? AND workos_user_id = ?`,
      )
      .bind(fixture.organizationId, fixture.ownerUserId)
      .first<{ status: string; workos_sync_status: string }>();
    expect(synced).toEqual({ status: 'inactive', workos_sync_status: 'synced' });
  });

  it('preserves a closed organization owner only for billing recovery after provider deletion', async () => {
    const fixture = await createOrganizationFixture();
    const memberUserId = id('user');
    const memberAccountId = await createAccount(memberUserId);
    const memberMembershipId = id('omem');
    const now = Date.now();
    await hostedDb()
      .prepare(
        `INSERT INTO hosted_organization_memberships
           (organization_id, billing_account_id, workos_client_id, workos_user_id, email,
            workos_membership_id, role, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'member', 'active', ?, ?)`,
      )
      .bind(
        fixture.organizationId,
        memberAccountId,
        HOSTED_CLIENT_ID,
        memberUserId,
        `${memberUserId}@example.test`,
        memberMembershipId,
        now,
        now,
      )
      .run();
    await hostedDb()
      .prepare(
        `INSERT INTO hosted_team_seat_assignments
           (id, organization_id, billing_account_id, state, created_at, updated_at)
         VALUES (?, ?, ?, 'assigned', ?, ?)`,
      )
      .bind(id('seat'), fixture.organizationId, memberAccountId, now, now)
      .run();
    await queueWorkOS(
      'GET',
      `/organizations/${fixture.workosOrganizationId}`,
      { error: 'not found' },
      404,
    );
    const { response } = await sendEvent('organization.deleted', {
      id: fixture.workosOrganizationId,
    });
    expect(response.status).toBe(200);

    const organization = await hostedDb()
      .prepare('SELECT status FROM hosted_organizations WHERE id = ?')
      .bind(fixture.organizationId)
      .first<{ status: string }>();
    expect(organization?.status).toBe('closed');
    const owner = await hostedDb()
      .prepare(
        `SELECT status, role, seat_opted_out, workos_membership_id
         FROM hosted_organization_memberships WHERE organization_id = ? AND workos_user_id = ?`,
      )
      .bind(fixture.organizationId, fixture.ownerUserId)
      .first<{
        status: string;
        role: string;
        seat_opted_out: number;
        workos_membership_id: string | null;
      }>();
    expect(owner).toEqual({
      status: 'active',
      role: 'owner',
      seat_opted_out: 1,
      workos_membership_id: null,
    });
    const member = await hostedDb()
      .prepare(
        `SELECT status FROM hosted_organization_memberships
         WHERE organization_id = ? AND workos_user_id = ?`,
      )
      .bind(fixture.organizationId, memberUserId)
      .first<{ status: string }>();
    expect(member?.status).toBe('inactive');
    const seats = await hostedDb()
      .prepare(
        "SELECT COUNT(*) AS count FROM hosted_team_seat_assignments WHERE organization_id = ? AND state != 'released'",
      )
      .bind(fixture.organizationId)
      .first<{ count: number }>();
    expect(seats?.count).toBe(0);
  });

  it('accepts only a reserved invitation while the organization still has effective capacity', async () => {
    const fixture = await createOrganizationFixture();
    const targetUserId = id('user');
    const targetAccountId = await createAccount(targetUserId);
    const invitationId = id('invite');
    const providerInvitationId = id('inv');
    const now = Date.now();
    const expiresAt = now + 60_000;
    const email = `${targetUserId}@example.test`;
    await hostedDb()
      .prepare(
        `INSERT INTO hosted_organization_invitations
           (id, organization_id, target_billing_account_id, target_workos_user_id, email,
            invited_by_workos_user_id, workos_invitation_id, state, expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      )
      .bind(
        invitationId,
        fixture.organizationId,
        targetAccountId,
        targetUserId,
        email,
        fixture.ownerUserId,
        providerInvitationId,
        expiresAt,
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
      .bind(id('seat'), fixture.organizationId, targetAccountId, invitationId, expiresAt, now, now)
      .run();
    await queueWorkOS('GET', `/user_management/invitations/${providerInvitationId}`, {
      id: providerInvitationId,
      organization_id: fixture.workosOrganizationId,
      email,
      state: 'accepted',
      accepted_user_id: targetUserId,
      expires_at: new Date(expiresAt).toISOString(),
    });
    await queueWorkOS(
      'GET',
      `/user_management/organization_memberships?organization_id=${fixture.workosOrganizationId}` +
        `&user_id=${targetUserId}&limit=100&statuses=active%2Cinactive%2Cpending`,
      {
        data: [
          {
            id: id('omem'),
            organization_id: fixture.workosOrganizationId,
            user_id: targetUserId,
            status: 'active',
            role: { slug: 'member' },
          },
        ],
      },
    );

    const { response } = await sendEvent('invitation.accepted', { id: providerInvitationId });
    expect(response.status).toBe(200);
    const member = await hostedDb()
      .prepare(
        `SELECT status, role FROM hosted_organization_memberships
         WHERE organization_id = ? AND workos_user_id = ?`,
      )
      .bind(fixture.organizationId, targetUserId)
      .first<{ status: string; role: string }>();
    expect(member).toEqual({ status: 'active', role: 'member' });
    const invite = await hostedDb()
      .prepare('SELECT state FROM hosted_organization_invitations WHERE id = ?')
      .bind(invitationId)
      .first<{ state: string }>();
    expect(invite?.state).toBe('accepted');
    const seat = await hostedDb()
      .prepare('SELECT state FROM hosted_team_seat_assignments WHERE invitation_id = ?')
      .bind(invitationId)
      .first<{ state: string }>();
    expect(seat?.state).toBe('assigned');
  });

  it('does not grant a seat when the organization closes before an accepted invitation is reconciled', async () => {
    const fixture = await createOrganizationFixture();
    const targetUserId = id('user');
    const targetAccountId = await createAccount(targetUserId);
    const invitationId = id('invite');
    const providerInvitationId = id('inv');
    const providerMembershipId = id('omem');
    const now = Date.now();
    const expiresAt = now + 60_000;
    const email = `${targetUserId}@example.test`;
    await hostedDb()
      .prepare(
        `INSERT INTO hosted_organization_invitations
           (id, organization_id, target_billing_account_id, target_workos_user_id, email,
            invited_by_workos_user_id, workos_invitation_id, state, expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      )
      .bind(
        invitationId,
        fixture.organizationId,
        targetAccountId,
        targetUserId,
        email,
        fixture.ownerUserId,
        providerInvitationId,
        expiresAt,
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
      .bind(id('seat'), fixture.organizationId, targetAccountId, invitationId, expiresAt, now, now)
      .run();
    await hostedDb()
      .prepare("UPDATE hosted_organizations SET status = 'closed' WHERE id = ?")
      .bind(fixture.organizationId)
      .run();
    await queueWorkOS('GET', `/user_management/invitations/${providerInvitationId}`, {
      id: providerInvitationId,
      organization_id: fixture.workosOrganizationId,
      email,
      state: 'accepted',
      accepted_user_id: targetUserId,
      expires_at: new Date(expiresAt).toISOString(),
    });
    const targetMembershipListPath =
      `/user_management/organization_memberships?organization_id=${fixture.workosOrganizationId}` +
      `&user_id=${targetUserId}&limit=100&statuses=active%2Cinactive%2Cpending`;
    const targetMembershipList = {
      data: [
        {
          id: providerMembershipId,
          organization_id: fixture.workosOrganizationId,
          user_id: targetUserId,
          status: 'active',
          role: { slug: 'member' },
        },
      ],
    };
    await queueWorkOS('GET', targetMembershipListPath, targetMembershipList);
    await queueWorkOS('GET', targetMembershipListPath, targetMembershipList);
    await queueWorkOS(
      'PUT',
      `/user_management/organization_memberships/${providerMembershipId}/deactivate`,
      {},
    );

    const { response } = await sendEvent('invitation.accepted', { id: providerInvitationId });
    expect(response.status).toBe(200);
    const member = await hostedDb()
      .prepare(
        `SELECT status FROM hosted_organization_memberships
         WHERE organization_id = ? AND workos_user_id = ?`,
      )
      .bind(fixture.organizationId, targetUserId)
      .first<{ status: string }>();
    expect(member).toBeNull();
    const invitation = await hostedDb()
      .prepare('SELECT state FROM hosted_organization_invitations WHERE id = ?')
      .bind(invitationId)
      .first<{ state: string }>();
    expect(invitation?.state).toBe('revoked');
    const seat = await hostedDb()
      .prepare('SELECT state FROM hosted_team_seat_assignments WHERE invitation_id = ?')
      .bind(invitationId)
      .first<{ state: string }>();
    expect(seat?.state).toBe('released');
  });

  it('uses WorkOS SDK-compatible comma-separated status filtering during reconciliation', async () => {
    const fixture = await createOrganizationFixture();
    await isolateReconcileOrganization(fixture.organizationId);
    await queueWorkOS('GET', `/organizations/${fixture.workosOrganizationId}`, {
      id: fixture.workosOrganizationId,
    });
    await queueWorkOS(
      'GET',
      `/user_management/invitations?organization_id=${fixture.workosOrganizationId}&limit=100`,
      { data: [], list_metadata: { after: null } },
    );
    const membershipPath =
      `/user_management/organization_memberships?organization_id=${fixture.workosOrganizationId}` +
      '&statuses=active%2Cinactive%2Cpending&limit=100';
    const membership = {
      id: fixture.ownerMembershipId,
      organization_id: fixture.workosOrganizationId,
      user_id: fixture.ownerUserId,
      status: 'active',
      role: { slug: 'admin' },
    };
    await queueWorkOS('GET', membershipPath, {
      data: [membership],
      list_metadata: { after: 'cursor-page-2' },
    });
    const nextPagePath = `${membershipPath}&after=cursor-page-2`;
    await queueWorkOS('GET', nextPagePath, { data: [], list_metadata: { after: null } });

    await runHostedOrganizationReconcile(testEnv());

    const calls = await workosCalls();
    expect(calls).toContainEqual({ method: 'GET', path: membershipPath });
    expect(calls).toContainEqual({ method: 'GET', path: nextPagePath });
    const owner = await hostedDb()
      .prepare(
        `SELECT status, workos_sync_status FROM hosted_organization_memberships
         WHERE organization_id = ? AND workos_user_id = ?`,
      )
      .bind(fixture.organizationId, fixture.ownerUserId)
      .first<{ status: string; workos_sync_status: string }>();
    expect(owner).toEqual({ status: 'active', workos_sync_status: 'synced' });
    const seat = await hostedDb()
      .prepare('SELECT state FROM hosted_team_seat_assignments WHERE organization_id = ?')
      .bind(fixture.organizationId)
      .first<{ state: string }>();
    expect(seat?.state).toBe('assigned');
  });

  it('continues reconciling later organizations after one provider failure, then reports failure', async () => {
    const first = await createOrganizationFixture();
    const second = await createOrganizationFixture();
    await hostedDb().batch([
      hostedDb()
        .prepare("UPDATE hosted_organizations SET status = 'closed' WHERE id NOT IN (?, ?)")
        .bind(first.organizationId, second.organizationId),
      hostedDb()
        .prepare(
          `UPDATE hosted_organization_memberships SET workos_sync_status = 'synced'
           WHERE organization_id NOT IN (?, ?)`,
        )
        .bind(first.organizationId, second.organizationId),
      hostedDb()
        .prepare(
          `UPDATE hosted_organization_invitations SET workos_sync_status = 'synced'
           WHERE organization_id NOT IN (?, ?)`,
        )
        .bind(first.organizationId, second.organizationId),
    ]);
    await queueWorkOS(
      'GET',
      `/organizations/${first.workosOrganizationId}`,
      { error: 'temporary provider failure' },
      503,
    );
    await queueWorkOS('GET', `/organizations/${second.workosOrganizationId}`, {
      id: second.workosOrganizationId,
    });
    await queueWorkOS(
      'GET',
      `/user_management/invitations?organization_id=${second.workosOrganizationId}&limit=100`,
      { data: [], list_metadata: { after: null } },
    );
    const secondMembershipPath =
      `/user_management/organization_memberships?organization_id=${second.workosOrganizationId}` +
      '&statuses=active%2Cinactive%2Cpending&limit=100';
    await queueWorkOS('GET', secondMembershipPath, {
      data: [
        {
          id: second.ownerMembershipId,
          organization_id: second.workosOrganizationId,
          user_id: second.ownerUserId,
          status: 'active',
          role: { slug: 'admin' },
        },
      ],
      list_metadata: { after: null },
    });

    await expect(runHostedOrganizationReconcile(testEnv())).rejects.toThrow();
    expect(await workosCalls()).toContainEqual({
      method: 'GET',
      path: `/organizations/${first.workosOrganizationId}`,
    });
    expect(await workosCalls()).toContainEqual({
      method: 'GET',
      path: secondMembershipPath,
    });
  });

  it('retries closed-org cleanup without removing its billing-only owner or regranting a seat', async () => {
    const fixture = await createOrganizationFixture({ ownerSeat: false });
    await isolateReconcileOrganization(fixture.organizationId);
    const now = Date.now();
    await hostedDb()
      .prepare(
        `INSERT INTO hosted_team_seat_assignments
           (id, organization_id, billing_account_id, state, created_at, updated_at)
         VALUES (?, ?, ?, 'assigned', ?, ?)`,
      )
      .bind(id('seat'), fixture.organizationId, fixture.ownerAccountId, now, now)
      .run();
    await hostedDb().batch([
      hostedDb()
        .prepare("UPDATE hosted_organizations SET status = 'closed' WHERE id = ?")
        .bind(fixture.organizationId),
      hostedDb()
        .prepare(
          `UPDATE hosted_organization_memberships
           SET workos_sync_status = 'pending', seat_opted_out = 1, workos_membership_id = NULL
           WHERE organization_id = ? AND workos_user_id = ?`,
        )
        .bind(fixture.organizationId, fixture.ownerUserId),
    ]);
    const providerMembership = {
      id: fixture.ownerMembershipId,
      organization_id: fixture.workosOrganizationId,
      user_id: fixture.ownerUserId,
      status: 'active',
      role: { slug: 'admin' },
    };
    const membershipPath =
      `/user_management/organization_memberships?organization_id=${fixture.workosOrganizationId}` +
      '&statuses=active%2Cinactive%2Cpending&limit=100';
    await queueWorkOS('GET', `/organizations/${fixture.workosOrganizationId}`, {
      id: fixture.workosOrganizationId,
    });
    await queueWorkOS(
      'GET',
      `/user_management/invitations?organization_id=${fixture.workosOrganizationId}&limit=100`,
      { data: [], list_metadata: { after: null } },
    );
    await queueWorkOS('GET', membershipPath, {
      data: [providerMembership],
      list_metadata: { after: null },
    });
    await queueWorkOS(
      'PUT',
      `/user_management/organization_memberships/${fixture.ownerMembershipId}/deactivate`,
      {},
    );

    await runHostedOrganizationReconcile(testEnv());

    const member = await hostedDb()
      .prepare(
        `SELECT status, role, seat_opted_out, workos_membership_id, workos_sync_status
         FROM hosted_organization_memberships
         WHERE organization_id = ? AND workos_user_id = ?`,
      )
      .bind(fixture.organizationId, fixture.ownerUserId)
      .first<{
        status: string;
        role: string;
        seat_opted_out: number;
        workos_membership_id: string | null;
        workos_sync_status: string;
      }>();
    expect(member).toEqual({
      status: 'active',
      role: 'owner',
      seat_opted_out: 1,
      workos_membership_id: null,
      workos_sync_status: 'synced',
    });
    const seat = await hostedDb()
      .prepare('SELECT state FROM hosted_team_seat_assignments WHERE organization_id = ?')
      .bind(fixture.organizationId)
      .first<{ state: string }>();
    expect(seat?.state).toBe('released');
    expect(await workosCalls()).toContainEqual({
      method: 'PUT',
      path: `/user_management/organization_memberships/${fixture.ownerMembershipId}/deactivate`,
    });
  });
});
