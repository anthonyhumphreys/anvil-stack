// BILL-07: shared-billing organizations. An organization sponsors hosted
// access through seats; it never owns or exposes members' personal sync data.

import {
  getOrganizationBillingSummary,
  getOrganizationTeamCapacity,
  latestSubscriptionForOrganization,
  refreshOrganizationTeamCapacity,
} from './billing';
import { getOrCreateAdmittedBillingAccount, isHostedIdentityAdmitted } from './admission';
import { isRecord, rpcErrorResponse } from '../rpc';
import { validateHostedIdentity, type HostedIdentity } from './identity';
import {
  getBillingAccountById,
  getBillingAccountByIdentity,
  type BillingAccountRow,
} from './store';
import { WorkOSRequestError, workosRequest } from './workos';

const ORGANIZATION_CREATE_LEASE_MS = 30_000;
const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PREVIEW_END_MS = 1_793_491_200_000;
const EFFECTIVE_SEAT_CAPACITY_SQL = `CASE
  WHEN EXISTS (
    SELECT 1 FROM stripe_subscriptions ss
    WHERE ss.organization_id = ? AND ss.plan_key = 'sync_team'
      AND ss.has_paid_invoice = 1 AND ss.status = 'active'
      AND ss.paid_through > ? AND ss.paid_seat_quantity BETWEEN 5 AND 50
      AND ss.stripe_subscription_id = (
        SELECT latest.stripe_subscription_id FROM stripe_subscriptions latest
        WHERE latest.organization_id = ? AND latest.plan_key = 'sync_team'
        ORDER BY latest.verified_at DESC, latest.updated_at DESC LIMIT 1
      )
  ) THEN COALESCE((SELECT effective_seat_capacity FROM organization_billing_state WHERE organization_id = ?), 0)
  WHEN ? < ${PREVIEW_END_MS} THEN MIN(
    COALESCE((SELECT effective_seat_capacity FROM organization_billing_state WHERE organization_id = ?), 5),
    COALESCE((SELECT preview_seat_capacity FROM organization_billing_state WHERE organization_id = ?), 5)
  )
  ELSE 0
END`;

type OrganizationStatus = 'creating' | 'active' | 'failed' | 'closed';
type MembershipRole = 'owner' | 'member';
type MembershipStatus = 'active' | 'inactive';
type InvitationState = 'creating' | 'pending' | 'accepted' | 'revoked' | 'expired' | 'failed';
type SeatState = 'reserved' | 'assigned' | 'released';

interface OrganizationRow {
  id: string;
  idempotency_key: string;
  workos_organization_id: string | null;
  name: string;
  status: OrganizationStatus;
  created_by_workos_user_id: string;
  create_lease_token: string | null;
  create_lease_until: number | null;
  created_at: number;
  updated_at: number;
}

interface MembershipRow {
  organization_id: string;
  billing_account_id: string;
  workos_client_id: string;
  workos_user_id: string;
  email: string;
  workos_membership_id: string | null;
  workos_sync_status: 'synced' | 'pending';
  role: MembershipRole;
  status: MembershipStatus;
  created_at: number;
  updated_at: number;
}

interface InvitationRow {
  id: string;
  organization_id: string;
  target_billing_account_id: string;
  target_workos_user_id: string;
  email: string;
  invited_by_workos_user_id: string;
  workos_invitation_id: string | null;
  state: InvitationState;
  workos_sync_status: 'synced' | 'pending';
  expires_at: number;
  created_at: number;
  updated_at: number;
}

interface SeatRow {
  id: string;
  organization_id: string;
  billing_account_id: string;
  invitation_id: string | null;
  state: SeatState;
  expires_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface HostedInvitationAcceptanceArgs {
  invitationId: string;
  organizationId: string;
  billingAccountId: string;
  workosUserId: string;
  email: string;
  providerMembershipId: string;
  now: number;
}

interface WorkOSUser {
  id: string;
  email: string;
  email_verified: boolean;
  last_sign_in_at: string | null;
}

interface WorkOSOrganization {
  id: string;
  external_id?: string | null;
}

interface WorkOSMembership {
  id: string;
  organization_id: string;
  user_id: string;
  status: 'active' | 'inactive' | 'pending';
  role?: { slug?: string } | null;
  role_slug?: string;
}

interface WorkOSInvitation {
  id: string;
  email: string;
  state: 'pending' | 'accepted' | 'revoked' | 'expired';
  organization_id: string | null;
  accepted_user_id: string | null;
  expires_at: string;
  accept_invitation_url?: string;
}

type ResolvedCaller = { account: BillingAccountRow; identity: HostedIdentity };

function newId(prefix: string): string {
  return `${prefix}${crypto.randomUUID()}`;
}

function nestedIdentity(body: Record<string, unknown>): HostedIdentity | null {
  const candidate = isRecord(body.identity) ? body.identity : body;
  return validateHostedIdentity(candidate) ? candidate : null;
}

async function resolveCaller(
  body: unknown,
  env: Env,
  db: D1Database,
): Promise<ResolvedCaller | Response> {
  if (!isRecord(body)) return rpcErrorResponse(undefined, 'malformed-request');
  const identity = nestedIdentity(body);
  if (identity === null) return rpcErrorResponse(undefined, 'malformed-request');
  const account = await getOrCreateAdmittedBillingAccount(env, db, identity);
  if (account === null) return rpcErrorResponse(undefined, 'not-found');
  if (account.lifecycle !== 'active') {
    return rpcErrorResponse(undefined, 'forbidden', { reason: 'account-deleted' });
  }
  return { account, identity };
}

async function organizationById(db: D1Database, id: string): Promise<OrganizationRow | null> {
  return db
    .prepare('SELECT * FROM hosted_organizations WHERE id = ?')
    .bind(id)
    .first<OrganizationRow>();
}

async function membershipForUser(
  db: D1Database,
  organizationId: string,
  workosUserId: string,
): Promise<MembershipRow | null> {
  return db
    .prepare(
      'SELECT * FROM hosted_organization_memberships WHERE organization_id = ? AND workos_user_id = ?',
    )
    .bind(organizationId, workosUserId)
    .first<MembershipRow>();
}

async function requireOwner(
  db: D1Database,
  organizationId: string,
  workosUserId: string,
): Promise<{ organization: OrganizationRow; membership: MembershipRow } | Response> {
  const organization = await organizationById(db, organizationId);
  if (organization === null || organization.status !== 'active') {
    return rpcErrorResponse(undefined, 'not-found');
  }
  const membership = await membershipForUser(db, organizationId, workosUserId);
  if (membership === null || membership.status !== 'active' || membership.role !== 'owner') {
    return rpcErrorResponse(undefined, 'forbidden');
  }
  return { organization, membership };
}

function workosRole(role: MembershipRole): string {
  return role === 'owner' ? 'admin' : 'member';
}

function validEmail(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 320) return null;
  const email = value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

function workosObject<T extends object>(value: unknown): T | null {
  return isRecord(value) ? (value as T) : null;
}

function parseWorkOSDate(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

async function workosUserById(env: Env, userId: string): Promise<WorkOSUser> {
  const value = await workosRequest<unknown>(
    env,
    `/user_management/users/${encodeURIComponent(userId)}`,
  );
  if (
    !isRecord(value) ||
    value.id !== userId ||
    typeof value.email !== 'string' ||
    typeof value.email_verified !== 'boolean'
  ) {
    throw new WorkOSRequestError(502, true);
  }
  return {
    id: userId,
    email: value.email.toLowerCase(),
    email_verified: value.email_verified,
    last_sign_in_at: typeof value.last_sign_in_at === 'string' ? value.last_sign_in_at : null,
  };
}

async function admittedBillingAccountForUser(
  db: D1Database,
  env: Env,
  userId: string,
  clientIdFallback: string,
): Promise<BillingAccountRow | null> {
  const clientId = env.HOSTED_WORKOS_CLIENT_ID ?? clientIdFallback;
  const identity = {
    workosClientId: clientId,
    workosUserId: userId,
  };
  if (!(await isHostedIdentityAdmitted(env, db, identity))) return null;
  const account = await getOrCreateAdmittedBillingAccount(env, db, identity);
  return account?.lifecycle === 'active' ? account : null;
}

async function activeMembershipFromWorkOS(
  env: Env,
  organizationId: string,
  userId: string,
): Promise<WorkOSMembership | null> {
  const url = new URL('https://api.workos.com/user_management/organization_memberships');
  url.searchParams.set('organization_id', organizationId);
  url.searchParams.set('user_id', userId);
  const value = await workosRequest<unknown>(env, `${url.pathname}${url.search}`);
  if (!isRecord(value) || !Array.isArray(value.data)) throw new WorkOSRequestError(502, true);
  const row = value.data.find(
    (candidate: unknown) =>
      isRecord(candidate) &&
      candidate.organization_id === organizationId &&
      candidate.user_id === userId &&
      candidate.status === 'active',
  );
  if (!isRecord(row) || typeof row.id !== 'string') return null;
  return row as unknown as WorkOSMembership;
}

async function ensureWorkOSMembership(
  env: Env,
  organizationId: string,
  userId: string,
  role: MembershipRole,
): Promise<WorkOSMembership> {
  const current = await activeMembershipFromWorkOS(env, organizationId, userId);
  if (current !== null) {
    await workosRequest<unknown>(
      env,
      `/user_management/organization_memberships/${encodeURIComponent(current.id)}`,
      { method: 'PUT', body: { role_slug: workosRole(role) } },
    );
    return { ...current, role_slug: workosRole(role) };
  }
  const value = await workosRequest<unknown>(env, '/user_management/organization_memberships', {
    method: 'POST',
    body: { organization_id: organizationId, user_id: userId, role_slug: workosRole(role) },
  });
  if (!isRecord(value) || typeof value.id !== 'string') throw new WorkOSRequestError(502, true);
  return value as unknown as WorkOSMembership;
}

async function insertLocalMembership(
  db: D1Database,
  organizationId: string,
  account: BillingAccountRow,
  email: string,
  role: MembershipRole,
  providerMembershipId: string,
  now: number,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO hosted_organization_memberships
         (organization_id, billing_account_id, workos_client_id, workos_user_id, email,
          workos_membership_id, workos_sync_status, role, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'synced', ?, 'active', ?, ?)
       ON CONFLICT(organization_id, workos_user_id) DO UPDATE SET
         billing_account_id = excluded.billing_account_id,
         workos_client_id = excluded.workos_client_id,
         email = excluded.email,
         workos_membership_id = excluded.workos_membership_id,
         workos_sync_status = 'synced',
         role = excluded.role,
         status = 'active',
         updated_at = excluded.updated_at`,
    )
    .bind(
      organizationId,
      account.id,
      account.workos_client_id,
      account.workos_user_id,
      email,
      providerMembershipId,
      role,
      now,
      now,
    )
    .run();
}

/**
 * Conditionally reserves or assigns one seat. SQLite's single INSERT ...
 * SELECT checks capacity and creates the row atomically; concurrent final
 * seat requests cannot both succeed. D1 batches serialize the expired-seat
 * release with the guarded insert.
 */
async function createSeat(
  db: D1Database,
  args: {
    organizationId: string;
    billingAccountId: string;
    invitationId: string | null;
    state: 'reserved' | 'assigned';
    expiresAt: number | null;
    now: number;
  },
): Promise<boolean> {
  const id = newId('seat_');
  const results = await db.batch([
    db
      .prepare(
        `UPDATE hosted_team_seat_assignments
         SET state = 'released', updated_at = ?
         WHERE state = 'reserved' AND expires_at <= ?
           AND (organization_id = ? OR billing_account_id = ?)`,
      )
      .bind(args.now, args.now, args.organizationId, args.billingAccountId),
    db
      .prepare(
        `INSERT INTO hosted_team_seat_assignments
           (id, organization_id, billing_account_id, invitation_id, state, expires_at, created_at, updated_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?
         WHERE (SELECT COUNT(*) FROM hosted_team_seat_assignments
                WHERE organization_id = ?
                  AND (state = 'assigned' OR (state = 'reserved' AND expires_at > ?))) < (${EFFECTIVE_SEAT_CAPACITY_SQL})
           AND NOT EXISTS (
             SELECT 1 FROM hosted_team_seat_assignments
             WHERE billing_account_id = ?
               AND (state = 'assigned' OR (state = 'reserved' AND expires_at > ?))
           )
           AND EXISTS (SELECT 1 FROM hosted_organizations WHERE id = ? AND status = 'active')`,
      )
      .bind(
        id,
        args.organizationId,
        args.billingAccountId,
        args.invitationId,
        args.state,
        args.expiresAt,
        args.now,
        args.now,
        args.organizationId, // organization seat count
        args.now, // unexpired reservations
        args.organizationId, // paid subscription exists
        args.now, // paid-through check
        args.organizationId, // latest subscription mirror row
        args.organizationId, // persisted effective capacity
        args.now, // preview cutoff
        args.organizationId, // persisted effective capacity during preview
        args.organizationId, // preview capacity
        args.billingAccountId,
        args.now,
        args.organizationId,
      ),
  ]);
  return results[1]?.meta.changes === 1;
}

/** Called by hosted billing after a team subscription becomes active. */
export async function assignOrganizationSeat(
  db: D1Database,
  organizationId: string,
  billingAccountId: string,
  now = Date.now(),
): Promise<boolean> {
  const member = await db
    .prepare(
      `SELECT billing_account_id FROM hosted_organization_memberships
       WHERE organization_id = ? AND billing_account_id = ? AND status = 'active' AND seat_opted_out = 0`,
    )
    .bind(organizationId, billingAccountId)
    .first();
  if (member === null) return false;
  return createSeat(db, {
    organizationId,
    billingAccountId,
    invitationId: null,
    state: 'assigned',
    expiresAt: null,
    now,
  });
}

/**
 * Billing calls this after a paid team subscription is mirrored. Owners that
 * explicitly opted into hosted access receive seats; billing-only owners do
 * not. The seat insert remains guarded by the persisted capacity in D1.
 */
export async function ensureOwnerSeatForPaidOrganization(
  db: D1Database,
  organizationId: string,
  now: number,
): Promise<void> {
  await refreshOrganizationTeamCapacity(db, organizationId, now);
  const owners = await db
    .prepare(
      `SELECT billing_account_id FROM hosted_organization_memberships
       WHERE organization_id = ? AND status = 'active' AND role = 'owner' AND seat_opted_out = 0
       ORDER BY created_at, workos_user_id`,
    )
    .bind(organizationId)
    .all<{ billing_account_id: string }>();
  for (const owner of owners.results ?? []) {
    const alreadyAssigned = await hasAssignedSeat(db, organizationId, owner.billing_account_id);
    if (!alreadyAssigned) {
      await assignOrganizationSeat(db, organizationId, owner.billing_account_id, now);
    }
  }
}

/**
 * Before a personal hosted account is deleted, make sure its user is not the
 * last active owner of any organization. Membership removal and seat release
 * are local-first; pending WorkOS mutations are retried by reconciliation.
 */
export async function prepareHostedAccountDeletion(
  db: D1Database,
  billingAccountId: string,
  now: number,
): Promise<boolean> {
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO hosted_organization_delete_guard (denied)
           SELECT 1 WHERE EXISTS (
             SELECT 1 FROM hosted_organization_memberships m
             JOIN hosted_organizations o ON o.id = m.organization_id
             WHERE m.billing_account_id = ? AND m.status = 'active' AND m.role = 'owner'
               AND (
                 o.status = 'active'
                 OR (o.status = 'closed' AND (
                   EXISTS (SELECT 1 FROM checkout_sessions cs
                           WHERE cs.organization_id = o.id AND cs.plan_key = 'sync_team'
                             AND cs.status = 'open')
                   OR EXISTS (
                     SELECT 1 FROM stripe_subscriptions ss
                     WHERE ss.organization_id = o.id AND ss.plan_key = 'sync_team'
                       AND ss.stripe_subscription_id = (
                         SELECT latest.stripe_subscription_id FROM stripe_subscriptions latest
                         WHERE latest.organization_id = o.id AND latest.plan_key = 'sync_team'
                         ORDER BY latest.verified_at DESC, latest.updated_at DESC LIMIT 1
                       )
                       AND ss.status NOT IN ('canceled', 'incomplete_expired')
                   )
                 ))
               )
               AND (SELECT COUNT(*) FROM hosted_organization_memberships other
                    WHERE other.organization_id = m.organization_id
                      AND other.status = 'active' AND other.role = 'owner') <= 1
           )`,
        )
        .bind(billingAccountId),
      db
        .prepare(
          `UPDATE hosted_organization_memberships SET status = 'inactive',
             workos_sync_status = 'pending', updated_at = ?
           WHERE billing_account_id = ? AND status = 'active'`,
        )
        .bind(now, billingAccountId),
      db
        .prepare(
          `UPDATE hosted_team_seat_assignments SET state = 'released', updated_at = ?
           WHERE billing_account_id = ? AND state IN ('assigned', 'reserved')`,
        )
        .bind(now, billingAccountId),
      db
        .prepare(
          `UPDATE hosted_organization_invitations SET state = 'revoked',
             workos_sync_status = 'pending', updated_at = ?
           WHERE target_billing_account_id = ? AND state IN ('creating', 'pending')`,
        )
        .bind(now, billingAccountId),
    ]);
    return true;
  } catch {
    // D1 batches are atomic: the CHECK abort rolls back if any org has a
    // sole-owner membership, leaving every membership and seat untouched.
    return false;
  }
}

function seatCounts(assigned: number, reserved: number, capacity: number) {
  return {
    assigned,
    reserved,
    available: Math.max(0, capacity - assigned - reserved),
  };
}

/**
 * Atomically converts an admitted invite reservation to an active membership.
 * Callers must first verify WorkOS says the exact target user accepted the
 * invitation and has an active provider membership. The transaction rechecks
 * all local admission, organization, reservation, and effective-capacity
 * constraints so webhook and callback races cannot over-assign seats.
 */
export async function completeHostedInvitationAcceptance(
  db: D1Database,
  args: HostedInvitationAcceptanceArgs,
): Promise<boolean> {
  const {
    invitationId,
    organizationId,
    billingAccountId,
    workosUserId,
    email,
    providerMembershipId,
    now,
  } = args;
  let results: D1Result[];
  try {
    results = await db.batch([
      db
        .prepare(
          `INSERT INTO hosted_organization_memberships
             (organization_id, billing_account_id, workos_client_id, workos_user_id, email,
              workos_membership_id, workos_sync_status, role, status, created_at, updated_at)
           SELECT ?, ?, ba.workos_client_id, ?, ?, ?, 'synced', 'member', 'active', ?, ?
           FROM billing_accounts ba
           WHERE ba.id = ? AND ba.workos_user_id = ? AND ba.lifecycle = 'active'
             AND EXISTS (SELECT 1 FROM hosted_organization_invitations i
                         WHERE i.id = ? AND i.organization_id = ? AND i.state = 'pending'
                           AND i.expires_at > ? AND i.target_workos_user_id = ?
                           AND i.target_billing_account_id = ? AND i.email = ? COLLATE NOCASE)
             AND EXISTS (SELECT 1 FROM hosted_team_seat_assignments s
                         WHERE s.invitation_id = ? AND s.organization_id = ?
                           AND s.billing_account_id = ? AND s.state = 'reserved'
                           AND s.expires_at > ?)
             AND EXISTS (SELECT 1 FROM hosted_organizations
                         WHERE id = ? AND status = 'active')
             AND (SELECT COUNT(*) FROM hosted_team_seat_assignments
                  WHERE organization_id = ?
                    AND (state = 'assigned' OR (state = 'reserved' AND expires_at > ?)))
                 <= (${EFFECTIVE_SEAT_CAPACITY_SQL})
           ON CONFLICT(organization_id, workos_user_id) DO UPDATE SET
             billing_account_id = excluded.billing_account_id,
             workos_client_id = excluded.workos_client_id,
             email = excluded.email,
             workos_membership_id = excluded.workos_membership_id,
             workos_sync_status = 'synced',
             role = CASE WHEN hosted_organization_memberships.status = 'active'
                              AND hosted_organization_memberships.role = 'owner'
                         THEN 'owner' ELSE 'member' END,
             status = 'active', seat_opted_out = 0, updated_at = excluded.updated_at`,
        )
        .bind(
          organizationId,
          billingAccountId,
          workosUserId,
          email,
          providerMembershipId,
          now,
          now,
          billingAccountId,
          workosUserId,
          invitationId,
          organizationId,
          now,
          workosUserId,
          billingAccountId,
          email,
          invitationId,
          organizationId,
          billingAccountId,
          now,
          organizationId,
          organizationId,
          now,
          organizationId,
          now,
          organizationId,
          organizationId,
          now,
          organizationId,
          organizationId,
        ),
      db
        .prepare(
          `UPDATE hosted_team_seat_assignments SET state = 'assigned', expires_at = NULL, updated_at = ?
           WHERE invitation_id = ? AND organization_id = ? AND billing_account_id = ?
             AND state = 'reserved' AND expires_at > ?
             AND EXISTS (SELECT 1 FROM hosted_organization_invitations
                         WHERE id = ? AND state = 'pending' AND expires_at > ?
                           AND target_workos_user_id = ? AND target_billing_account_id = ?)
             AND EXISTS (SELECT 1 FROM hosted_organization_memberships
                         WHERE organization_id = ? AND billing_account_id = ?
                           AND workos_user_id = ? AND workos_membership_id = ?
                           AND status = 'active')
             AND EXISTS (SELECT 1 FROM hosted_organizations
                         WHERE id = ? AND status = 'active')
             AND (SELECT COUNT(*) FROM hosted_team_seat_assignments
                  WHERE organization_id = ?
                    AND (state = 'assigned' OR (state = 'reserved' AND expires_at > ?)))
                 <= (${EFFECTIVE_SEAT_CAPACITY_SQL})`,
        )
        .bind(
          now,
          invitationId,
          organizationId,
          billingAccountId,
          now,
          invitationId,
          now,
          workosUserId,
          billingAccountId,
          organizationId,
          billingAccountId,
          workosUserId,
          providerMembershipId,
          organizationId,
          organizationId,
          now,
          organizationId,
          now,
          organizationId,
          organizationId,
          now,
          organizationId,
          organizationId,
        ),
      db
        .prepare(
          `UPDATE hosted_organization_invitations SET state = 'accepted', updated_at = ?
           WHERE id = ? AND organization_id = ? AND state = 'pending' AND expires_at > ?
             AND target_workos_user_id = ? AND target_billing_account_id = ?
             AND EXISTS (SELECT 1 FROM hosted_team_seat_assignments
                         WHERE invitation_id = ? AND state = 'assigned')
             AND EXISTS (SELECT 1 FROM hosted_organization_memberships
                         WHERE organization_id = ? AND billing_account_id = ?
                           AND workos_user_id = ? AND workos_membership_id = ?
                           AND status = 'active')
             AND EXISTS (SELECT 1 FROM hosted_organizations
                         WHERE id = ? AND status = 'active')`,
        )
        .bind(
          now,
          invitationId,
          organizationId,
          now,
          workosUserId,
          billingAccountId,
          invitationId,
          organizationId,
          billingAccountId,
          workosUserId,
          providerMembershipId,
          organizationId,
        ),
    ]);
  } catch (error) {
    console.error('Hosted invitation acceptance transaction failed', error);
    throw error;
  }
  return results.every((result) => result.meta.changes === 1);
}

async function organizationView(
  db: D1Database,
  env: Env,
  organization: OrganizationRow,
  viewer: MembershipRow,
  now: number,
): Promise<Record<string, unknown>> {
  const billing = await getOrganizationBillingSummary(db, organization.id, now, env);
  const counts = await db
    .prepare(
      `SELECT
         SUM(CASE WHEN state = 'assigned' THEN 1 ELSE 0 END) AS assigned,
         SUM(CASE WHEN state = 'reserved' AND expires_at > ? THEN 1 ELSE 0 END) AS reserved
       FROM hosted_team_seat_assignments WHERE organization_id = ?`,
    )
    .bind(now, organization.id)
    .first<{ assigned: number | null; reserved: number | null }>();
  const membersResult = await db
    .prepare(
      `SELECT m.workos_user_id, m.email, m.role, m.status,
              EXISTS (SELECT 1 FROM hosted_team_seat_assignments s
                      WHERE s.organization_id = m.organization_id
                        AND s.billing_account_id = m.billing_account_id AND s.state = 'assigned') AS seat_assigned
       FROM hosted_organization_memberships m
       WHERE m.organization_id = ? AND m.status = 'active'
       ORDER BY m.created_at, m.workos_user_id LIMIT 100`,
    )
    .bind(organization.id)
    .all<{
      workos_user_id: string;
      email: string;
      role: MembershipRole;
      status: MembershipStatus;
      seat_assigned: number;
    }>();
  const invitationsResult = await db
    .prepare(
      `SELECT id, email, state, expires_at
       FROM hosted_organization_invitations
       WHERE organization_id = ? AND state IN ('creating', 'pending')
       ORDER BY created_at DESC LIMIT 100`,
    )
    .bind(organization.id)
    .all<{ id: string; email: string; state: InvitationState; expires_at: number }>();
  const providerSync = await db
    .prepare(
      `SELECT
         EXISTS (SELECT 1 FROM hosted_organization_memberships
                 WHERE organization_id = ? AND workos_sync_status = 'pending')
         OR EXISTS (SELECT 1 FROM hosted_organization_invitations
                    WHERE organization_id = ? AND workos_sync_status = 'pending') AS pending`,
    )
    .bind(organization.id, organization.id)
    .first<{ pending: number }>();
  const seatCapacity = billing.seatCapacity;
  const assigned = counts?.assigned ?? 0;
  const reserved = counts?.reserved ?? 0;
  return {
    id: organization.id,
    name: organization.name,
    status: organization.status,
    billingRecoveryOnly: organization.status === 'closed',
    providerSyncPending: providerSync?.pending === 1,
    membership: {
      role: viewer.role,
      seatAssigned: await hasAssignedSeat(db, organization.id, viewer.billing_account_id),
    },
    billing,
    seats: seatCounts(assigned, reserved, seatCapacity),
    members: (membersResult.results ?? []).map((member) => ({
      workosUserId: member.workos_user_id,
      email: member.email,
      role: member.role,
      seatAssigned: member.seat_assigned === 1,
      fundedBy: member.seat_assigned === 1 ? 'team' : 'none',
    })),
    invitations: (invitationsResult.results ?? []).map((invitation) => ({
      id: invitation.id,
      email: invitation.email,
      state: invitation.state,
      expiresAt: invitation.expires_at,
    })),
  };
}

async function hasAssignedSeat(
  db: D1Database,
  organizationId: string,
  billingAccountId: string,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT id FROM hosted_team_seat_assignments
       WHERE organization_id = ? AND billing_account_id = ? AND state = 'assigned'`,
    )
    .bind(organizationId, billingAccountId)
    .first();
  return row !== null;
}

async function createOrganization(
  body: Record<string, unknown>,
  caller: ResolvedCaller,
  env: Env,
  db: D1Database,
): Promise<Response> {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const idempotencyKey = body.idempotencyKey;
  const ownerSeatAssigned =
    typeof body.ownerSeatAssigned === 'boolean' ? body.ownerSeatAssigned : true;
  if (
    name.length < 2 ||
    name.length > 80 ||
    typeof idempotencyKey !== 'string' ||
    !/^[A-Za-z0-9_-]{16,128}$/.test(idempotencyKey)
  ) {
    return rpcErrorResponse(undefined, 'malformed-request');
  }
  const now = Date.now();
  const leaseToken = newId('lease_');
  const newOrganizationId = newId('anvil_org_');
  try {
    await db
      .prepare(
        `INSERT INTO hosted_organizations
           (id, idempotency_key, workos_organization_id, name, status,
            created_by_workos_user_id, create_lease_token, create_lease_until, created_at, updated_at)
         VALUES (?, ?, NULL, ?, 'creating', ?, NULL, NULL, ?, ?)
         ON CONFLICT(idempotency_key) DO NOTHING`,
      )
      .bind(newOrganizationId, idempotencyKey, name, caller.identity.workosUserId, now, now)
      .run();
  } catch {
    return rpcErrorResponse(undefined, 'conflict');
  }
  const organization = await db
    .prepare('SELECT * FROM hosted_organizations WHERE idempotency_key = ?')
    .bind(idempotencyKey)
    .first<OrganizationRow>();
  if (organization === null) return rpcErrorResponse(undefined, 'unavailable');
  if (organization.created_by_workos_user_id !== caller.identity.workosUserId) {
    return rpcErrorResponse(undefined, 'conflict');
  }
  if (organization.status === 'closed') return rpcErrorResponse(undefined, 'conflict');
  if (organization.status === 'active') {
    const membership = await membershipForUser(db, organization.id, caller.identity.workosUserId);
    if (membership === null || membership.status !== 'active') {
      return rpcErrorResponse(undefined, 'forbidden');
    }
    return Response.json({
      organization: await organizationView(db, env, organization, membership, now),
    });
  }
  const claimed = await db
    .prepare(
      `UPDATE hosted_organizations
       SET create_lease_token = ?, create_lease_until = ?, updated_at = ?
       WHERE id = ? AND status IN ('creating', 'failed')
         AND (create_lease_until IS NULL OR create_lease_until <= ?)`,
    )
    .bind(leaseToken, now + ORGANIZATION_CREATE_LEASE_MS, now, organization.id, now)
    .run();
  if (claimed.meta.changes !== 1) {
    return rpcErrorResponse(undefined, 'conflict', { reason: 'creation-in-progress' });
  }
  try {
    const workosOrg = await findOrCreateWorkOSOrganization(env, organization.id, name);
    const updated = await db
      .prepare(
        `UPDATE hosted_organizations SET workos_organization_id = ?, name = ?, updated_at = ?
         WHERE id = ? AND create_lease_token = ?`,
      )
      .bind(workosOrg.id, name, Date.now(), organization.id, leaseToken)
      .run();
    if (updated.meta.changes !== 1) throw new Error('organization create lease lost');
    const user = await workosUserById(env, caller.identity.workosUserId);
    if (!user.email_verified) return rpcErrorResponse(undefined, 'forbidden');
    const providerMembership = await ensureWorkOSMembership(
      env,
      workosOrg.id,
      caller.identity.workosUserId,
      'owner',
    );
    await insertLocalMembership(
      db,
      organization.id,
      caller.account,
      user.email,
      'owner',
      providerMembership.id,
      Date.now(),
    );
    if (!ownerSeatAssigned) {
      await db
        .prepare(
          `UPDATE hosted_organization_memberships SET seat_opted_out = 1, updated_at = ?
           WHERE organization_id = ? AND workos_user_id = ? AND role = 'owner'`,
        )
        .bind(Date.now(), organization.id, caller.identity.workosUserId)
        .run();
    }
    await db
      .prepare(
        `UPDATE hosted_organizations
         SET status = 'active', create_lease_token = NULL, create_lease_until = NULL, updated_at = ?
         WHERE id = ? AND create_lease_token = ?`,
      )
      .bind(Date.now(), organization.id, leaseToken)
      .run();
    await refreshOrganizationTeamCapacity(db, organization.id, Date.now());
    const capacity = await getOrganizationTeamCapacity(db, organization.id, Date.now());
    if (capacity > 0 && ownerSeatAssigned) {
      await assignOrganizationSeat(db, organization.id, caller.account.id);
    }
    const activeOrg = await organizationById(db, organization.id);
    const membership = await membershipForUser(db, organization.id, caller.identity.workosUserId);
    if (activeOrg === null || membership === null)
      throw new Error('organization activation failed');
    return Response.json({
      organization: await organizationView(db, env, activeOrg, membership, Date.now()),
    });
  } catch (error) {
    await db
      .prepare(
        `UPDATE hosted_organizations SET create_lease_token = NULL, create_lease_until = NULL,
         status = 'creating', updated_at = ? WHERE id = ? AND create_lease_token = ?`,
      )
      .bind(Date.now(), organization.id, leaseToken)
      .run();
    if (error instanceof WorkOSRequestError && !error.retryable && error.status !== 404) {
      return rpcErrorResponse(undefined, 'unavailable');
    }
    return rpcErrorResponse(undefined, 'unavailable');
  }
}

async function findOrCreateWorkOSOrganization(
  env: Env,
  externalId: string,
  name: string,
): Promise<WorkOSOrganization> {
  try {
    const existing = await workosRequest<unknown>(
      env,
      `/organizations/external_id/${encodeURIComponent(externalId)}`,
    );
    if (!isRecord(existing) || typeof existing.id !== 'string') {
      throw new WorkOSRequestError(502, true);
    }
    return existing as unknown as WorkOSOrganization;
  } catch (error) {
    if (!(error instanceof WorkOSRequestError) || error.status !== 404) throw error;
  }
  const value = await workosRequest<unknown>(env, '/organizations', {
    method: 'POST',
    body: { name, external_id: externalId, allow_profiles_outside_organization: false },
  });
  if (!isRecord(value) || typeof value.id !== 'string') throw new WorkOSRequestError(502, true);
  return value as unknown as WorkOSOrganization;
}

async function listOrganizations(
  caller: ResolvedCaller,
  env: Env,
  db: D1Database,
): Promise<Response> {
  const rows = await db
    .prepare(
      `SELECT o.*, m.billing_account_id, m.workos_client_id, m.workos_user_id, m.email,
              m.workos_membership_id, m.workos_sync_status, m.role, m.status AS membership_status,
              m.created_at AS membership_created_at, m.updated_at AS membership_updated_at
       FROM hosted_organizations o
       JOIN hosted_organization_memberships m ON m.organization_id = o.id
       WHERE m.billing_account_id = ? AND m.status = 'active'
         AND (o.status = 'active' OR (o.status = 'closed' AND m.role = 'owner'))
       ORDER BY o.created_at DESC LIMIT 100`,
    )
    .bind(caller.account.id)
    .all<Record<string, unknown>>();
  const organizations: Record<string, unknown>[] = [];
  for (const row of rows.results ?? []) {
    const organization = row as unknown as OrganizationRow;
    const membership: MembershipRow = {
      organization_id: organization.id,
      billing_account_id: caller.account.id,
      workos_client_id: caller.identity.workosClientId,
      workos_user_id: caller.identity.workosUserId,
      email: typeof row.email === 'string' ? row.email : '',
      workos_membership_id:
        typeof row.workos_membership_id === 'string' ? row.workos_membership_id : null,
      workos_sync_status: row.workos_sync_status === 'pending' ? 'pending' : 'synced',
      role: row.role === 'owner' ? 'owner' : 'member',
      status: 'active',
      created_at: typeof row.membership_created_at === 'number' ? row.membership_created_at : 0,
      updated_at: typeof row.membership_updated_at === 'number' ? row.membership_updated_at : 0,
    };
    organizations.push(await organizationView(db, env, organization, membership, Date.now()));
  }
  return Response.json({ organizations });
}

async function inviteMember(
  body: Record<string, unknown>,
  caller: ResolvedCaller,
  env: Env,
  db: D1Database,
): Promise<Response> {
  const organizationId = body.organizationId;
  const email = validEmail(body.email);
  if (typeof organizationId !== 'string' || email === null) {
    return rpcErrorResponse(undefined, 'malformed-request');
  }
  const authorization = await requireOwner(db, organizationId, caller.identity.workosUserId);
  if (authorization instanceof Response) return authorization;
  const providerOrganizationId = authorization.organization.workos_organization_id;
  if (providerOrganizationId === null) return rpcErrorResponse(undefined, 'unavailable');
  const userListUrl = new URL('https://api.workos.com/user_management/users');
  userListUrl.searchParams.set('email', email);
  userListUrl.searchParams.set('limit', '100');
  const users = await workosRequest<unknown>(env, `${userListUrl.pathname}${userListUrl.search}`);
  if (!isRecord(users) || !Array.isArray(users.data))
    return rpcErrorResponse(undefined, 'unavailable');
  const matches = users.data.filter(
    (candidate: unknown) =>
      isRecord(candidate) &&
      typeof candidate.id === 'string' &&
      typeof candidate.email === 'string' &&
      candidate.email.toLowerCase() === email &&
      candidate.email_verified === true,
  );
  if (matches.length !== 1 || !isRecord(matches[0])) {
    return rpcErrorResponse(undefined, 'not-found', { reason: 'user-not-admitted' });
  }
  const targetUserId = matches[0].id as string;
  const targetAccount = await admittedBillingAccountForUser(
    db,
    env,
    targetUserId,
    caller.identity.workosClientId,
  );
  if (targetAccount === null) {
    return rpcErrorResponse(undefined, 'forbidden', { reason: 'user-not-admitted' });
  }
  const targetMembership = await membershipForUser(db, organizationId, targetUserId);
  if (targetMembership?.status === 'active') {
    return rpcErrorResponse(undefined, 'conflict', { reason: 'already-member' });
  }
  const existingInvite = await db
    .prepare(
      `SELECT * FROM hosted_organization_invitations
       WHERE organization_id = ? AND email = ? COLLATE NOCASE AND state IN ('creating', 'pending')`,
    )
    .bind(organizationId, email)
    .first<InvitationRow>();
  if (existingInvite !== null) {
    if (existingInvite.workos_invitation_id === null) {
      return rpcErrorResponse(undefined, 'conflict', { reason: 'invitation-in-progress' });
    }
    const existing = await workosRequest<unknown>(
      env,
      `/user_management/invitations/${encodeURIComponent(existingInvite.workos_invitation_id)}`,
    );
    if (!isRecord(existing) || typeof existing.accept_invitation_url !== 'string') {
      return rpcErrorResponse(undefined, 'unavailable');
    }
    return Response.json({
      invitation: {
        id: existingInvite.id,
        email,
        state: existingInvite.state,
        expiresAt: existingInvite.expires_at,
        acceptInvitationUrl: existing.accept_invitation_url,
      },
    });
  }
  const now = Date.now();
  await refreshOrganizationTeamCapacity(db, organizationId, now);
  const capacity = await getOrganizationTeamCapacity(db, organizationId, now);
  if (capacity < 1)
    return rpcErrorResponse(undefined, 'quota-exceeded', { reason: 'no-team-seats' });
  const invitationId = newId('inv_');
  const expiresAt = now + INVITATION_TTL_MS;
  const invitationRow: InvitationRow = {
    id: invitationId,
    organization_id: organizationId,
    target_billing_account_id: targetAccount.id,
    target_workos_user_id: targetUserId,
    email,
    invited_by_workos_user_id: caller.identity.workosUserId,
    workos_invitation_id: null,
    state: 'creating',
    workos_sync_status: 'synced',
    expires_at: expiresAt,
    created_at: now,
    updated_at: now,
  };
  let reserved = false;
  try {
    const results = await db.batch([
      db
        .prepare(
          `UPDATE hosted_team_seat_assignments SET state = 'released', updated_at = ?
           WHERE state = 'reserved' AND expires_at <= ?
             AND (organization_id = ? OR billing_account_id = ?)`,
        )
        .bind(now, now, organizationId, targetAccount.id),
      db
        .prepare(
          `INSERT INTO hosted_organization_invitations
             (id, organization_id, target_billing_account_id, target_workos_user_id, email,
              invited_by_workos_user_id, workos_invitation_id, state, workos_sync_status,
              expires_at, created_at, updated_at)
           SELECT ?, ?, ?, ?, ?, ?, NULL, 'creating', 'synced', ?, ?, ?
           WHERE EXISTS (SELECT 1 FROM hosted_organizations WHERE id = ? AND status = 'active')`,
        )
        .bind(
          invitationId,
          organizationId,
          targetAccount.id,
          targetUserId,
          email,
          caller.identity.workosUserId,
          expiresAt,
          now,
          now,
          organizationId,
        ),
      db
        .prepare(
          `INSERT INTO hosted_team_seat_assignments
             (id, organization_id, billing_account_id, invitation_id, state, expires_at, created_at, updated_at)
           SELECT ?, ?, ?, ?, 'reserved', ?, ?, ?
           WHERE EXISTS (SELECT 1 FROM hosted_organization_invitations WHERE id = ? AND state = 'creating')
             AND (SELECT COUNT(*) FROM hosted_team_seat_assignments
                  WHERE organization_id = ?
                    AND (state = 'assigned' OR (state = 'reserved' AND expires_at > ?))) < (${EFFECTIVE_SEAT_CAPACITY_SQL})
             AND NOT EXISTS (SELECT 1 FROM hosted_team_seat_assignments
                             WHERE billing_account_id = ?
                               AND (state = 'assigned' OR (state = 'reserved' AND expires_at > ?)))`,
        )
        .bind(
          newId('seat_'),
          organizationId,
          targetAccount.id,
          invitationId,
          expiresAt,
          now,
          now,
          invitationId,
          organizationId,
          now,
          organizationId,
          now,
          organizationId,
          organizationId,
          now,
          organizationId,
          organizationId,
          targetAccount.id,
          now,
        ),
    ]);
    if (results[1]?.meta.changes !== 1 || results[2]?.meta.changes !== 1) {
      await db
        .prepare(
          "UPDATE hosted_organization_invitations SET state = 'failed', updated_at = ? WHERE id = ?",
        )
        .bind(Date.now(), invitationId)
        .run();
      return rpcErrorResponse(undefined, 'quota-exceeded', { reason: 'no-team-seats' });
    }
    reserved = true;
  } catch {
    return rpcErrorResponse(undefined, 'conflict', {
      reason: 'invitation-already-exists-or-user-sponsored',
    });
  }
  try {
    const providerInvitation = await workosRequest<unknown>(env, '/user_management/invitations', {
      method: 'POST',
      body: {
        email,
        organization_id: providerOrganizationId,
        role_slug: workosRole('member'),
        expires_in_days: 7,
        inviter_user_id: caller.identity.workosUserId,
      },
    });
    if (
      !isRecord(providerInvitation) ||
      typeof providerInvitation.id !== 'string' ||
      providerInvitation.organization_id !== providerOrganizationId ||
      typeof providerInvitation.accept_invitation_url !== 'string'
    ) {
      throw new WorkOSRequestError(502, true);
    }
    const providerExpiry = parseWorkOSDate(providerInvitation.expires_at);
    const actualExpiry = providerExpiry ?? expiresAt;
    await db.batch([
      db
        .prepare(
          `UPDATE hosted_organization_invitations
           SET workos_invitation_id = ?, state = 'pending', expires_at = ?, updated_at = ?
           WHERE id = ? AND state = 'creating'`,
        )
        .bind(providerInvitation.id, actualExpiry, Date.now(), invitationId),
      db
        .prepare(
          `UPDATE hosted_team_seat_assignments SET expires_at = ?, updated_at = ?
           WHERE invitation_id = ? AND state = 'reserved'`,
        )
        .bind(actualExpiry, Date.now(), invitationId),
    ]);
    return Response.json({
      invitation: {
        id: invitationId,
        email,
        state: 'pending',
        expiresAt: actualExpiry,
        acceptInvitationUrl: providerInvitation.accept_invitation_url,
      },
      seats: await organizationSeatCounts(db, organizationId, capacity, Date.now()),
    });
  } catch (error) {
    if (error instanceof WorkOSRequestError && !error.retryable) {
      await db.batch([
        db
          .prepare(
            `UPDATE hosted_organization_invitations SET state = 'failed', updated_at = ? WHERE id = ?`,
          )
          .bind(Date.now(), invitationId),
        db
          .prepare(
            `UPDATE hosted_team_seat_assignments SET state = 'released', updated_at = ?
             WHERE invitation_id = ? AND state = 'reserved'`,
          )
          .bind(Date.now(), invitationId),
      ]);
    } else if (!reserved) {
      return rpcErrorResponse(undefined, 'unavailable');
    }
    return rpcErrorResponse(undefined, 'unavailable');
  }
}

async function organizationSeatCounts(
  db: D1Database,
  organizationId: string,
  capacity: number,
  now: number,
): Promise<{ assigned: number; reserved: number; available: number }> {
  const counts = await db
    .prepare(
      `SELECT SUM(CASE WHEN state = 'assigned' THEN 1 ELSE 0 END) AS assigned,
              SUM(CASE WHEN state = 'reserved' AND expires_at > ? THEN 1 ELSE 0 END) AS reserved
       FROM hosted_team_seat_assignments WHERE organization_id = ?`,
    )
    .bind(now, organizationId)
    .first<{ assigned: number | null; reserved: number | null }>();
  return seatCounts(counts?.assigned ?? 0, counts?.reserved ?? 0, capacity);
}

async function acceptInvitation(
  body: Record<string, unknown>,
  caller: ResolvedCaller,
  env: Env,
  db: D1Database,
): Promise<Response> {
  const token = body.invitationToken;
  if (typeof token !== 'string' || token.length < 16 || token.length > 512) {
    return rpcErrorResponse(undefined, 'malformed-request');
  }
  let providerInvitation: WorkOSInvitation;
  try {
    const value = await workosRequest<unknown>(
      env,
      `/user_management/invitations/by_token/${encodeURIComponent(token)}`,
    );
    if (
      !isRecord(value) ||
      typeof value.id !== 'string' ||
      typeof value.email !== 'string' ||
      typeof value.state !== 'string'
    ) {
      return rpcErrorResponse(undefined, 'unavailable');
    }
    providerInvitation = value as unknown as WorkOSInvitation;
  } catch (error) {
    if (error instanceof WorkOSRequestError && error.status === 404) {
      return rpcErrorResponse(undefined, 'not-found', { reason: 'invalid-invitation' });
    }
    return rpcErrorResponse(undefined, 'unavailable');
  }
  if (providerInvitation.organization_id === null) {
    return Response.json({ accepted: false, reason: 'not-anvil-organization-invitation' });
  }
  if (providerInvitation.state !== 'accepted') {
    return rpcErrorResponse(undefined, 'conflict', { reason: 'invitation-not-accepted' });
  }
  if (providerInvitation.accepted_user_id !== caller.identity.workosUserId) {
    return rpcErrorResponse(undefined, 'forbidden', { reason: 'invitation-user-mismatch' });
  }
  const localInvitation = await db
    .prepare(
      `SELECT i.* FROM hosted_organization_invitations i
       JOIN hosted_organizations o ON o.id = i.organization_id
       WHERE i.workos_invitation_id = ? AND o.workos_organization_id = ?`,
    )
    .bind(providerInvitation.id, providerInvitation.organization_id)
    .first<InvitationRow>();
  if (localInvitation === null) {
    return rpcErrorResponse(undefined, 'forbidden', {
      reason: 'unmanaged-organization-invitation',
    });
  }
  if (localInvitation.target_workos_user_id !== caller.identity.workosUserId) {
    return rpcErrorResponse(undefined, 'forbidden', { reason: 'invitation-user-mismatch' });
  }
  if (
    providerInvitation.email.trim().toLowerCase() !== localInvitation.email.trim().toLowerCase()
  ) {
    return rpcErrorResponse(undefined, 'forbidden', { reason: 'invitation-email-mismatch' });
  }
  if (localInvitation.state === 'accepted') {
    const org = await organizationById(db, localInvitation.organization_id);
    const membership = await membershipForUser(
      db,
      localInvitation.organization_id,
      caller.identity.workosUserId,
    );
    if (org === null || membership === null) return rpcErrorResponse(undefined, 'unavailable');
    return Response.json({
      accepted: true,
      organization: await organizationView(db, env, org, membership, Date.now()),
    });
  }
  if (localInvitation.state !== 'pending' || localInvitation.expires_at <= Date.now()) {
    return rpcErrorResponse(undefined, 'forbidden', { reason: 'invitation-expired-or-revoked' });
  }
  if (caller.account.id !== localInvitation.target_billing_account_id) {
    return rpcErrorResponse(undefined, 'forbidden', { reason: 'account-not-admitted' });
  }
  let workosMembership: WorkOSMembership | null;
  try {
    workosMembership = await activeMembershipFromWorkOS(
      env,
      providerInvitation.organization_id,
      caller.identity.workosUserId,
    );
  } catch {
    return rpcErrorResponse(undefined, 'unavailable');
  }
  if (workosMembership === null) {
    return rpcErrorResponse(undefined, 'forbidden', { reason: 'workos-membership-not-active' });
  }
  const now = Date.now();
  const accepted = await completeHostedInvitationAcceptance(db, {
    invitationId: localInvitation.id,
    organizationId: localInvitation.organization_id,
    billingAccountId: localInvitation.target_billing_account_id,
    workosUserId: localInvitation.target_workos_user_id,
    email: localInvitation.email,
    providerMembershipId: workosMembership.id,
    now,
  });
  if (!accepted) {
    return rpcErrorResponse(undefined, 'conflict', { reason: 'seat-reservation-unavailable' });
  }
  const organization = await organizationById(db, localInvitation.organization_id);
  const membership = await membershipForUser(
    db,
    localInvitation.organization_id,
    caller.identity.workosUserId,
  );
  if (organization === null || membership === null)
    return rpcErrorResponse(undefined, 'unavailable');
  return Response.json({
    accepted: true,
    organization: await organizationView(db, env, organization, membership, now),
  });
}

async function mutateMembership(args: {
  db: D1Database;
  env: Env;
  organizationId: string;
  targetUserId: string;
  nextRole?: MembershipRole;
  now: number;
}): Promise<{ ok: true; providerSyncPending: boolean } | { ok: false; response: Response }> {
  const { db, env, organizationId, targetUserId, nextRole, now } = args;
  const member = await membershipForUser(db, organizationId, targetUserId);
  if (member === null || member.status !== 'active') {
    return { ok: false, response: rpcErrorResponse(undefined, 'not-found') };
  }
  if (member.role === 'owner' && nextRole !== 'owner') {
    const changed =
      nextRole === 'member'
        ? await db
            .prepare(
              `UPDATE hosted_organization_memberships SET role = 'member', workos_sync_status = 'pending', updated_at = ?
               WHERE organization_id = ? AND workos_user_id = ? AND status = 'active' AND role = 'owner'
                 AND (SELECT COUNT(*) FROM hosted_organization_memberships
                      WHERE organization_id = ? AND status = 'active' AND role = 'owner') > 1`,
            )
            .bind(now, organizationId, targetUserId, organizationId)
            .run()
        : await db
            .prepare(
              `UPDATE hosted_organization_memberships SET status = 'inactive', workos_sync_status = 'pending', updated_at = ?
               WHERE organization_id = ? AND workos_user_id = ? AND status = 'active' AND role = 'owner'
                 AND (SELECT COUNT(*) FROM hosted_organization_memberships
                      WHERE organization_id = ? AND status = 'active' AND role = 'owner') > 1`,
            )
            .bind(now, organizationId, targetUserId, organizationId)
            .run();
    if (changed.meta.changes !== 1) {
      return {
        ok: false,
        response: rpcErrorResponse(undefined, 'conflict', { reason: 'last-owner' }),
      };
    }
  } else if (nextRole !== undefined) {
    const changed = await db
      .prepare(
        `UPDATE hosted_organization_memberships SET role = ?, workos_sync_status = 'pending', updated_at = ?
         WHERE organization_id = ? AND workos_user_id = ? AND status = 'active'`,
      )
      .bind(nextRole, now, organizationId, targetUserId)
      .run();
    if (changed.meta.changes !== 1) {
      return { ok: false, response: rpcErrorResponse(undefined, 'conflict') };
    }
  } else {
    const changed = await db
      .prepare(
        `UPDATE hosted_organization_memberships SET status = 'inactive', workos_sync_status = 'pending', updated_at = ?
         WHERE organization_id = ? AND workos_user_id = ? AND status = 'active'`,
      )
      .bind(now, organizationId, targetUserId)
      .run();
    if (changed.meta.changes !== 1) {
      return { ok: false, response: rpcErrorResponse(undefined, 'conflict') };
    }
  }
  if (nextRole === undefined) {
    await db
      .prepare(
        `UPDATE hosted_team_seat_assignments SET state = 'released', updated_at = ?
         WHERE organization_id = ? AND billing_account_id = ? AND state = 'assigned'`,
      )
      .bind(now, organizationId, member.billing_account_id)
      .run();
  }
  try {
    const providerMembershipId = member.workos_membership_id;
    if (providerMembershipId === null) throw new WorkOSRequestError(404, false);
    if (nextRole === undefined) {
      await workosRequest<unknown>(
        env,
        `/user_management/organization_memberships/${encodeURIComponent(providerMembershipId)}/deactivate`,
        { method: 'PUT' },
      );
    } else {
      await workosRequest<unknown>(
        env,
        `/user_management/organization_memberships/${encodeURIComponent(providerMembershipId)}`,
        { method: 'PUT', body: { role_slug: workosRole(nextRole) } },
      );
    }
    await db
      .prepare(
        `UPDATE hosted_organization_memberships SET workos_sync_status = 'synced', updated_at = ?
         WHERE organization_id = ? AND workos_user_id = ?`,
      )
      .bind(Date.now(), organizationId, targetUserId)
      .run();
    return { ok: true, providerSyncPending: false };
  } catch {
    // Local membership and seat changes are authoritative immediately; the
    // webhook/cron repair path retries the provider mutation.
    return { ok: true, providerSyncPending: true };
  }
}

async function removeMember(
  body: Record<string, unknown>,
  caller: ResolvedCaller,
  env: Env,
  db: D1Database,
  leaving = false,
): Promise<Response> {
  const organizationId = body.organizationId;
  const targetUserId = leaving ? caller.identity.workosUserId : body.workosUserId;
  if (typeof organizationId !== 'string' || typeof targetUserId !== 'string') {
    return rpcErrorResponse(undefined, 'malformed-request');
  }
  if (!leaving) {
    const owner = await requireOwner(db, organizationId, caller.identity.workosUserId);
    if (owner instanceof Response) return owner;
  }
  const result = await mutateMembership({
    db,
    env,
    organizationId,
    targetUserId,
    now: Date.now(),
  });
  if (!result.ok) return result.response;
  return Response.json({ removed: true, providerSyncPending: result.providerSyncPending });
}

async function changeRole(
  body: Record<string, unknown>,
  caller: ResolvedCaller,
  env: Env,
  db: D1Database,
): Promise<Response> {
  const organizationId = body.organizationId;
  const targetUserId = body.workosUserId;
  const role = body.role;
  if (
    typeof organizationId !== 'string' ||
    typeof targetUserId !== 'string' ||
    (role !== 'owner' && role !== 'member')
  ) {
    return rpcErrorResponse(undefined, 'malformed-request');
  }
  const owner = await requireOwner(db, organizationId, caller.identity.workosUserId);
  if (owner instanceof Response) return owner;
  const result = await mutateMembership({
    db,
    env,
    organizationId,
    targetUserId,
    nextRole: role,
    now: Date.now(),
  });
  if (!result.ok) return result.response;
  return Response.json({ role, providerSyncPending: result.providerSyncPending });
}

async function assignOrReleaseSeat(
  body: Record<string, unknown>,
  caller: ResolvedCaller,
  db: D1Database,
): Promise<Response> {
  const organizationId = body.organizationId;
  const targetUserId = body.workosUserId;
  const assigned = body.assigned;
  if (
    typeof organizationId !== 'string' ||
    typeof targetUserId !== 'string' ||
    typeof assigned !== 'boolean'
  ) {
    return rpcErrorResponse(undefined, 'malformed-request');
  }
  const owner = await requireOwner(db, organizationId, caller.identity.workosUserId);
  if (owner instanceof Response) return owner;
  const member = await membershipForUser(db, organizationId, targetUserId);
  if (member === null || member.status !== 'active')
    return rpcErrorResponse(undefined, 'not-found');
  if (!assigned) {
    await db.batch([
      db
        .prepare(
          `UPDATE hosted_team_seat_assignments SET state = 'released', updated_at = ?
           WHERE organization_id = ? AND billing_account_id = ? AND state = 'assigned'`,
        )
        .bind(Date.now(), organizationId, member.billing_account_id),
      db
        .prepare(
          `UPDATE hosted_organization_memberships SET seat_opted_out = 1, updated_at = ?
           WHERE organization_id = ? AND workos_user_id = ? AND role = 'owner' AND status = 'active'`,
        )
        .bind(Date.now(), organizationId, targetUserId),
    ]);
    return Response.json({ assigned: false });
  }
  if (await hasAssignedSeat(db, organizationId, member.billing_account_id)) {
    return Response.json({ assigned: true });
  }
  const wasOptedOut = await db
    .prepare(
      `SELECT seat_opted_out FROM hosted_organization_memberships
       WHERE organization_id = ? AND workos_user_id = ? AND role = 'owner' AND status = 'active'`,
    )
    .bind(organizationId, targetUserId)
    .first<{ seat_opted_out: number }>();
  if (wasOptedOut !== null) {
    await db
      .prepare(
        `UPDATE hosted_organization_memberships SET seat_opted_out = 0, updated_at = ?
         WHERE organization_id = ? AND workos_user_id = ? AND role = 'owner' AND status = 'active'`,
      )
      .bind(Date.now(), organizationId, targetUserId)
      .run();
  }
  await refreshOrganizationTeamCapacity(db, organizationId, Date.now());
  const assignedResult = await assignOrganizationSeat(
    db,
    organizationId,
    member.billing_account_id,
  );
  if (!assignedResult) {
    if (wasOptedOut !== null && wasOptedOut.seat_opted_out === 1) {
      await db
        .prepare(
          `UPDATE hosted_organization_memberships SET seat_opted_out = 1, updated_at = ?
           WHERE organization_id = ? AND workos_user_id = ? AND role = 'owner' AND status = 'active'`,
        )
        .bind(Date.now(), organizationId, targetUserId)
        .run();
    }
    return rpcErrorResponse(undefined, 'quota-exceeded', { reason: 'no-team-seats' });
  }
  return Response.json({ assigned: true });
}

async function revokeInvitation(
  body: Record<string, unknown>,
  caller: ResolvedCaller,
  env: Env,
  db: D1Database,
): Promise<Response> {
  const organizationId = body.organizationId;
  const invitationId = body.invitationId;
  if (typeof organizationId !== 'string' || typeof invitationId !== 'string') {
    return rpcErrorResponse(undefined, 'malformed-request');
  }
  const owner = await requireOwner(db, organizationId, caller.identity.workosUserId);
  if (owner instanceof Response) return owner;
  const invitation = await db
    .prepare('SELECT * FROM hosted_organization_invitations WHERE id = ? AND organization_id = ?')
    .bind(invitationId, organizationId)
    .first<InvitationRow>();
  if (invitation === null) return rpcErrorResponse(undefined, 'not-found');
  if (invitation.state === 'accepted') return rpcErrorResponse(undefined, 'conflict');
  if (invitation.state === 'revoked' || invitation.state === 'expired') {
    return Response.json({
      revoked: true,
      providerSyncPending: invitation.workos_sync_status === 'pending',
    });
  }
  const now = Date.now();
  await db.batch([
    db
      .prepare(
        `UPDATE hosted_organization_invitations SET state = 'revoked', workos_sync_status = 'pending', updated_at = ?
         WHERE id = ? AND state IN ('creating', 'pending')`,
      )
      .bind(now, invitationId),
    db
      .prepare(
        `UPDATE hosted_team_seat_assignments SET state = 'released', updated_at = ?
         WHERE invitation_id = ? AND state = 'reserved'`,
      )
      .bind(now, invitationId),
  ]);
  const providerSyncPending = await syncRevokedInvitation(env, db, {
    ...invitation,
    state: 'revoked',
    workos_sync_status: 'pending',
    updated_at: now,
  });
  return Response.json({ revoked: true, providerSyncPending });
}

async function closeOrganization(
  body: Record<string, unknown>,
  caller: ResolvedCaller,
  env: Env,
  db: D1Database,
): Promise<Response> {
  const organizationId = body.organizationId;
  if (typeof organizationId !== 'string') return rpcErrorResponse(undefined, 'malformed-request');
  const existing = await organizationById(db, organizationId);
  if (existing === null) return rpcErrorResponse(undefined, 'not-found');
  if (existing.status === 'closed') {
    const priorOwner = await db
      .prepare(
        `SELECT role FROM hosted_organization_memberships
         WHERE organization_id = ? AND workos_user_id = ?`,
      )
      .bind(organizationId, caller.identity.workosUserId)
      .first<{ role: MembershipRole }>();
    if (priorOwner?.role === 'owner') return Response.json({ closed: true, organizationId });
    return rpcErrorResponse(undefined, 'forbidden');
  }
  const authorization = await requireOwner(db, organizationId, caller.identity.workosUserId);
  if (authorization instanceof Response) return authorization;
  const now = Date.now();
  const subscription = await latestSubscriptionForOrganization(db, organizationId);
  const subscriptionIsTerminal =
    subscription === null || ['canceled', 'incomplete_expired'].includes(subscription.status);
  if (!subscriptionIsTerminal) {
    return rpcErrorResponse(undefined, 'conflict', { reason: 'team-subscription-active' });
  }
  const openCheckout = await db
    .prepare(
      "SELECT 1 FROM checkout_sessions WHERE organization_id = ? AND status = 'open' LIMIT 1",
    )
    .bind(organizationId)
    .first();
  if (openCheckout !== null) {
    return rpcErrorResponse(undefined, 'conflict', { reason: 'team-checkout-open' });
  }
  const memberships = await db
    .prepare(
      `SELECT workos_user_id, workos_membership_id FROM hosted_organization_memberships
       WHERE organization_id = ? AND status = 'active'`,
    )
    .bind(organizationId)
    .all<{ workos_user_id: string; workos_membership_id: string | null }>();
  const invitations = await db
    .prepare(
      `SELECT * FROM hosted_organization_invitations
       WHERE organization_id = ? AND state IN ('creating', 'pending')`,
    )
    .bind(organizationId)
    .all<InvitationRow>();
  let changed: D1Result[];
  try {
    changed = await db.batch([
      db
        .prepare(
          `INSERT INTO hosted_organization_delete_guard (denied)
           SELECT CASE WHEN EXISTS (
             SELECT 1 FROM hosted_organizations o
             WHERE o.id = ? AND o.status = 'active'
               AND NOT EXISTS (SELECT 1 FROM checkout_sessions cs
                               WHERE cs.organization_id = o.id
                                 AND cs.plan_key = 'sync_team' AND cs.status = 'open')
               AND NOT EXISTS (
                 SELECT 1 FROM stripe_subscriptions ss
                 WHERE ss.organization_id = o.id AND ss.plan_key = 'sync_team'
                   AND ss.stripe_subscription_id = (
                     SELECT latest.stripe_subscription_id FROM stripe_subscriptions latest
                     WHERE latest.organization_id = o.id AND latest.plan_key = 'sync_team'
                     ORDER BY latest.verified_at DESC, latest.updated_at DESC LIMIT 1
                   )
                   AND ss.status NOT IN ('canceled', 'incomplete_expired')
               )
           ) THEN 0 ELSE 1 END`,
        )
        .bind(organizationId),
      db
        .prepare(
          "UPDATE hosted_organizations SET status = 'closed', updated_at = ? WHERE id = ? AND status = 'active'",
        )
        .bind(now, organizationId),
      db
        .prepare(
          `UPDATE hosted_organization_memberships SET status = 'inactive',
           workos_sync_status = 'pending', updated_at = ?
         WHERE organization_id = ? AND status = 'active'`,
        )
        .bind(now, organizationId),
      db
        .prepare(
          `UPDATE hosted_team_seat_assignments SET state = 'released', updated_at = ?
         WHERE organization_id = ? AND state IN ('assigned', 'reserved')`,
        )
        .bind(now, organizationId),
      db
        .prepare(
          `UPDATE hosted_organization_invitations SET state = 'revoked',
           workos_sync_status = 'pending', updated_at = ?
         WHERE organization_id = ? AND state IN ('creating', 'pending')`,
        )
        .bind(now, organizationId),
      db
        .prepare(
          `UPDATE organization_billing_state SET effective_seat_capacity = 0, updated_at = ?
           WHERE organization_id = ?`,
        )
        .bind(now, organizationId),
      db.prepare('DELETE FROM hosted_organization_delete_guard WHERE denied = 0'),
    ]);
  } catch (error) {
    const message =
      error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
    if (message.includes('check constraint failed') && message.includes('denied')) {
      return rpcErrorResponse(undefined, 'conflict', { reason: 'billing-state-changed' });
    }
    throw error;
  }
  if (changed[1]?.meta.changes !== 1) return rpcErrorResponse(undefined, 'conflict');
  let providerSyncPending = false;
  for (const membership of memberships.results ?? []) {
    try {
      if (membership.workos_membership_id !== null) {
        await workosRequest<unknown>(
          env,
          `/user_management/organization_memberships/${encodeURIComponent(membership.workos_membership_id)}/deactivate`,
          { method: 'PUT' },
        );
      } else {
        throw new WorkOSRequestError(404, false);
      }
      await db
        .prepare(
          `UPDATE hosted_organization_memberships SET workos_sync_status = 'synced', updated_at = ?
           WHERE organization_id = ? AND workos_user_id = ?`,
        )
        .bind(Date.now(), organizationId, membership.workos_user_id)
        .run();
    } catch {
      providerSyncPending = true;
    }
  }
  for (const invitation of invitations.results ?? []) {
    const pending = await syncRevokedInvitation(env, db, {
      ...invitation,
      state: 'revoked',
      workos_sync_status: 'pending',
    });
    providerSyncPending ||= pending;
  }
  return Response.json({ closed: true, organizationId, providerSyncPending });
}

async function syncRevokedInvitation(
  env: Env,
  db: D1Database,
  invitation: InvitationRow,
): Promise<boolean> {
  if (invitation.workos_invitation_id === null) return true;
  try {
    const value = await workosRequest<unknown>(
      env,
      `/user_management/invitations/${encodeURIComponent(invitation.workos_invitation_id)}`,
    );
    if (!isRecord(value)) throw new WorkOSRequestError(502, true);
    if (value.state === 'pending') {
      await workosRequest<unknown>(
        env,
        `/user_management/invitations/${encodeURIComponent(invitation.workos_invitation_id)}/revoke`,
        { method: 'POST', body: {} },
      );
    } else if (value.state === 'accepted' && typeof value.organization_id === 'string') {
      const membership = await activeMembershipFromWorkOS(
        env,
        value.organization_id,
        invitation.target_workos_user_id,
      );
      if (membership !== null) {
        await db
          .prepare(
            `INSERT INTO hosted_organization_memberships
               (organization_id, billing_account_id, workos_client_id, workos_user_id, email,
                workos_membership_id, workos_sync_status, role, status, created_at, updated_at)
             VALUES (?, ?, '', ?, ?, ?, 'pending', 'member', 'inactive', ?, ?)
             ON CONFLICT(organization_id, workos_user_id) DO UPDATE SET
               status = 'inactive', workos_sync_status = 'pending', updated_at = excluded.updated_at`,
          )
          .bind(
            invitation.organization_id,
            invitation.target_billing_account_id,
            invitation.target_workos_user_id,
            invitation.email,
            membership.id,
            Date.now(),
            Date.now(),
          )
          .run();
        await workosRequest<unknown>(
          env,
          `/user_management/organization_memberships/${encodeURIComponent(membership.id)}/deactivate`,
          { method: 'PUT' },
        );
      }
    }
    await db
      .prepare(
        `UPDATE hosted_organization_invitations SET workos_sync_status = 'synced', updated_at = ? WHERE id = ?`,
      )
      .bind(Date.now(), invitation.id)
      .run();
    return false;
  } catch {
    return true;
  }
}

/**
 * Website-facing HMAC service channel. The parent dispatcher verifies the
 * signature first, then calls this function with the normalized path/body.
 */
export async function handleHostedOrganizationRequest(
  path: string,
  body: unknown,
  env: Env,
  db: D1Database,
): Promise<Response | null> {
  const routes = new Set([
    '/internal/hosted/organizations',
    '/internal/hosted/organization-create',
    '/internal/hosted/organization-invite',
    '/internal/hosted/organization-invitation-accept',
    '/internal/hosted/organization-member-remove',
    '/internal/hosted/organization-leave',
    '/internal/hosted/organization-role',
    '/internal/hosted/organization-seat',
    '/internal/hosted/organization-member-seat',
    '/internal/hosted/organization-invitation-revoke',
    '/internal/hosted/organization-close',
  ]);
  if (!routes.has(path)) return null;
  if (!isRecord(body)) return rpcErrorResponse(undefined, 'malformed-request');
  const resolved = await resolveCaller(body, env, db);
  if (resolved instanceof Response) return resolved;
  try {
    switch (path) {
      case '/internal/hosted/organizations':
        return await listOrganizations(resolved, env, db);
      case '/internal/hosted/organization-create':
        return await createOrganization(body, resolved, env, db);
      case '/internal/hosted/organization-invite':
        return await inviteMember(body, resolved, env, db);
      case '/internal/hosted/organization-invitation-accept':
        return await acceptInvitation(body, resolved, env, db);
      case '/internal/hosted/organization-member-remove':
        return await removeMember(body, resolved, env, db);
      case '/internal/hosted/organization-leave':
        return await removeMember(body, resolved, env, db, true);
      case '/internal/hosted/organization-role':
        return await changeRole(body, resolved, env, db);
      case '/internal/hosted/organization-seat':
      case '/internal/hosted/organization-member-seat':
        return await assignOrReleaseSeat(body, resolved, db);
      case '/internal/hosted/organization-invitation-revoke':
        return await revokeInvitation(body, resolved, env, db);
      case '/internal/hosted/organization-close':
        return await closeOrganization(body, resolved, env, db);
      default:
        return null;
    }
  } catch (error) {
    if (error instanceof WorkOSRequestError && error.status === 404) {
      return rpcErrorResponse(undefined, 'not-found');
    }
    return rpcErrorResponse(undefined, 'unavailable');
  }
}
