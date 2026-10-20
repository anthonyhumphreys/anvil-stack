// WorkOS is the provider of truth for organization membership and invitation
// lifecycle. Local membership status, role, and seat assignments remain the
// application authorization model; WorkOS state is mirrored and reconciled.

import { rpcErrorResponse } from '../rpc';
import { completeHostedInvitationAcceptance } from './organizations';
import { WorkOSRequestError, workosRequest } from './workos';

const WEBHOOK_BODY_MAX_BYTES = 256 * 1024;
const WEBHOOK_TOLERANCE_MS = 5 * 60 * 1000;
const WORKOS_PAGE_SIZE = 100;
const LOCAL_ORG_PAGE_SIZE = 100;
const STALE_CREATE_MS = 10 * 60 * 1000;

type MembershipStatus = 'active' | 'inactive' | 'pending';
type InvitationState = 'pending' | 'accepted' | 'revoked' | 'expired';
type LocalInvitationState = 'creating' | 'pending' | 'accepted' | 'revoked' | 'expired' | 'failed';
type LocalMembershipRole = 'owner' | 'member';

interface WorkOSEvent {
  id: string;
  event: string;
  data: Record<string, unknown>;
}

interface WorkOSMembership {
  id: string;
  organization_id: string;
  user_id: string;
  status: MembershipStatus;
  role_slug: string | null;
}

interface WorkOSInvitation {
  id: string;
  organization_id: string | null;
  email: string;
  state: InvitationState;
  accepted_user_id: string | null;
  expires_at: string;
}

interface WorkOSList<T> {
  data: T[];
  list_metadata?: { after?: string | null };
}

interface LocalOrganization {
  id: string;
  workos_organization_id: string;
  status: 'creating' | 'active' | 'failed' | 'closed';
}

interface LocalMembership {
  organization_id: string;
  billing_account_id: string;
  workos_user_id: string;
  workos_membership_id: string | null;
  role: LocalMembershipRole;
  status: 'active' | 'inactive';
  seat_opted_out: number;
  workos_sync_status: 'synced' | 'pending';
}

interface LocalInvitation {
  id: string;
  organization_id: string;
  target_billing_account_id: string;
  target_workos_user_id: string;
  email: string;
  workos_invitation_id: string | null;
  state: LocalInvitationState;
  expires_at: number;
  workos_sync_status: 'synced' | 'pending';
  updated_at: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function expectedWorkOSRole(role: LocalMembershipRole): string {
  return role === 'owner' ? 'admin' : 'member';
}

function workosRoleSlug(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const role = value['role'];
  return isRecord(role) && typeof role['slug'] === 'string' ? role['slug'] : null;
}

function parseMembership(value: unknown): WorkOSMembership | null {
  if (
    !isRecord(value) ||
    typeof value['id'] !== 'string' ||
    typeof value['organization_id'] !== 'string' ||
    typeof value['user_id'] !== 'string' ||
    (value['status'] !== 'active' &&
      value['status'] !== 'inactive' &&
      value['status'] !== 'pending')
  ) {
    return null;
  }
  return {
    id: value['id'],
    organization_id: value['organization_id'],
    user_id: value['user_id'],
    status: value['status'],
    role_slug: workosRoleSlug(value),
  };
}

function parseInvitation(value: unknown): WorkOSInvitation | null {
  if (
    !isRecord(value) ||
    typeof value['id'] !== 'string' ||
    (value['organization_id'] !== null && typeof value['organization_id'] !== 'string') ||
    typeof value['email'] !== 'string' ||
    (value['state'] !== 'pending' &&
      value['state'] !== 'accepted' &&
      value['state'] !== 'revoked' &&
      value['state'] !== 'expired') ||
    (value['accepted_user_id'] !== null && typeof value['accepted_user_id'] !== 'string') ||
    typeof value['expires_at'] !== 'string'
  ) {
    return null;
  }
  return {
    id: value['id'],
    organization_id: value['organization_id'],
    email: value['email'],
    state: value['state'],
    accepted_user_id: value['accepted_user_id'],
    expires_at: value['expires_at'],
  };
}

function parseEvent(value: unknown): WorkOSEvent | null {
  if (
    !isRecord(value) ||
    typeof value['id'] !== 'string' ||
    !/^event_[A-Za-z0-9_-]{1,240}$/.test(value['id']) ||
    typeof value['event'] !== 'string' ||
    !isRecord(value['data'])
  ) {
    return null;
  }
  return { id: value['id'], event: value['event'], data: value['data'] };
}

function parseSignatureHeader(header: string): { timestamp: number; signatures: string[] } | null {
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const fragment of header.split(',')) {
    const [rawKey, ...rawValueParts] = fragment.trim().split('=');
    if (rawKey === undefined || rawValueParts.length === 0) continue;
    const value = rawValueParts.join('=').trim();
    if (rawKey.trim() === 't') {
      if (timestamp !== null || !/^\d{13}$/.test(value)) return null;
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed)) return null;
      timestamp = parsed;
    } else if (rawKey.trim() === 'v1' && /^[0-9a-fA-F]{64}$/.test(value)) {
      signatures.push(value.toLowerCase());
    }
  }
  return timestamp === null || signatures.length === 0 ? null : { timestamp, signatures };
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function constantTimeHexEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

async function verifyWorkOSSignature(
  rawBody: string,
  signatureHeader: string,
  secret: string,
  now: number,
): Promise<boolean> {
  const parsed = parseSignatureHeader(signatureHeader);
  if (parsed === null || Math.abs(now - parsed.timestamp) > WEBHOOK_TOLERANCE_MS) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signed = new TextEncoder().encode(`${parsed.timestamp}.${rawBody}`);
  const expected = bytesToHex(new Uint8Array(await crypto.subtle.sign('HMAC', key, signed)));
  return parsed.signatures.some((signature) => constantTimeHexEqual(expected, signature));
}

async function getLocalOrganizationByWorkOSId(
  db: D1Database,
  workosOrganizationId: string,
): Promise<LocalOrganization | null> {
  return db
    .prepare(
      'SELECT id, workos_organization_id, status FROM hosted_organizations WHERE workos_organization_id = ?',
    )
    .bind(workosOrganizationId)
    .first<LocalOrganization>();
}

async function membershipByProviderId(
  db: D1Database,
  workosMembershipId: string,
): Promise<LocalMembership | null> {
  return db
    .prepare(
      `SELECT organization_id, billing_account_id, workos_user_id,
              workos_membership_id, role, status, seat_opted_out, workos_sync_status
       FROM hosted_organization_memberships WHERE workos_membership_id = ?`,
    )
    .bind(workosMembershipId)
    .first<LocalMembership>();
}

async function membershipByIdentity(
  db: D1Database,
  organizationId: string,
  workosUserId: string,
): Promise<LocalMembership | null> {
  return db
    .prepare(
      `SELECT organization_id, billing_account_id, workos_user_id,
              workos_membership_id, role, status, seat_opted_out, workos_sync_status
       FROM hosted_organization_memberships WHERE organization_id = ? AND workos_user_id = ?`,
    )
    .bind(organizationId, workosUserId)
    .first<LocalMembership>();
}

async function releaseMembershipSeat(
  db: D1Database,
  member: LocalMembership,
  now: number,
  syncStatus: 'synced' | 'pending' = 'synced',
): Promise<void> {
  await db.batch([
    db
      .prepare(
        `UPDATE hosted_organization_memberships
         SET status = 'inactive', workos_sync_status = ?, updated_at = ?
         WHERE organization_id = ? AND workos_user_id = ?`,
      )
      .bind(syncStatus, now, member.organization_id, member.workos_user_id),
    db
      .prepare(
        `UPDATE hosted_team_seat_assignments SET state = 'released', updated_at = ?
         WHERE organization_id = ? AND billing_account_id = ? AND state IN ('assigned', 'reserved')`,
      )
      .bind(now, member.organization_id, member.billing_account_id),
  ]);
}

function isBillingOnlyOwner(member: LocalMembership): boolean {
  return member.role === 'owner' && member.status === 'active' && member.seat_opted_out === 1;
}

async function retainBillingOwnerAndReleaseSeat(
  db: D1Database,
  member: LocalMembership,
  now: number,
  syncStatus: 'synced' | 'pending',
): Promise<void> {
  await db.batch([
    db
      .prepare(
        `UPDATE hosted_organization_memberships
         SET seat_opted_out = 1, workos_membership_id = NULL,
             workos_sync_status = ?, updated_at = ?
         WHERE organization_id = ? AND workos_user_id = ? AND role = 'owner' AND status = 'active'`,
      )
      .bind(syncStatus, now, member.organization_id, member.workos_user_id),
    db
      .prepare(
        `UPDATE hosted_team_seat_assignments SET state = 'released', updated_at = ?
         WHERE organization_id = ? AND billing_account_id = ? AND state IN ('assigned', 'reserved')`,
      )
      .bind(now, member.organization_id, member.billing_account_id),
  ]);
}

async function setMembershipSyncStatus(
  db: D1Database,
  member: LocalMembership,
  status: 'synced' | 'pending',
  now: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE hosted_organization_memberships SET workos_sync_status = ?, updated_at = ?
       WHERE organization_id = ? AND workos_user_id = ?`,
    )
    .bind(status, now, member.organization_id, member.workos_user_id)
    .run();
}

async function providerMembershipById(
  env: Env,
  workosMembershipId: string,
): Promise<WorkOSMembership | null> {
  try {
    const value = await workosRequest<unknown>(
      env,
      `/user_management/organization_memberships/${encodeURIComponent(workosMembershipId)}`,
    );
    const membership = parseMembership(value);
    if (membership === null || membership.id !== workosMembershipId) {
      throw new WorkOSRequestError(502, true);
    }
    return membership;
  } catch (error) {
    if (error instanceof WorkOSRequestError && error.status === 404) return null;
    throw error;
  }
}

async function membershipsForUser(
  env: Env,
  organizationId: string,
  userId: string,
): Promise<WorkOSMembership[]> {
  const query = new URLSearchParams({
    organization_id: organizationId,
    user_id: userId,
    limit: '100',
  });
  query.set('statuses', 'active,inactive,pending');
  const value = await workosRequest<unknown>(
    env,
    `/user_management/organization_memberships?${query.toString()}`,
  );
  if (!isRecord(value) || !Array.isArray(value.data)) throw new WorkOSRequestError(502, true);
  const members = value.data.map(parseMembership);
  if (
    members.some(
      (member) =>
        member === null || member.organization_id !== organizationId || member.user_id !== userId,
    )
  ) {
    throw new WorkOSRequestError(502, true);
  }
  return members as WorkOSMembership[];
}

async function deactivateOrDeleteProviderMembership(
  env: Env,
  membership: WorkOSMembership,
): Promise<void> {
  if (membership.status === 'active') {
    await workosRequest<unknown>(
      env,
      `/user_management/organization_memberships/${encodeURIComponent(membership.id)}/deactivate`,
      { method: 'PUT' },
    );
  } else if (membership.status === 'pending') {
    await workosRequest<unknown>(
      env,
      `/user_management/organization_memberships/${encodeURIComponent(membership.id)}`,
      { method: 'DELETE' },
    );
  }
}

async function cleanupUnexpectedMembership(
  env: Env,
  db: D1Database,
  organizationId: string,
  membership: WorkOSMembership,
): Promise<void> {
  const existing = await membershipByIdentity(db, organizationId, membership.user_id);
  if (existing !== null && existing.status === 'active') {
    // The user may already be a legitimate member through a separate Anvil
    // invitation. Do not tear down that independent membership because a
    // different invitation was misaccepted.
    return;
  }
  if (existing !== null) await releaseMembershipSeat(db, existing, Date.now(), 'pending');
  await deactivateOrDeleteProviderMembership(env, membership);
  if (existing !== null && existing.status === 'inactive') {
    await setMembershipSyncStatus(db, existing, 'synced', Date.now());
  }
}

async function invitationByProviderId(
  db: D1Database,
  workosInvitationId: string,
): Promise<LocalInvitation | null> {
  return db
    .prepare('SELECT * FROM hosted_organization_invitations WHERE workos_invitation_id = ?')
    .bind(workosInvitationId)
    .first<LocalInvitation>();
}

async function providerInvitationById(
  env: Env,
  workosInvitationId: string,
): Promise<WorkOSInvitation | null> {
  try {
    const value = await workosRequest<unknown>(
      env,
      `/user_management/invitations/${encodeURIComponent(workosInvitationId)}`,
    );
    const invitation = parseInvitation(value);
    if (invitation === null || invitation.id !== workosInvitationId) {
      throw new WorkOSRequestError(502, true);
    }
    return invitation;
  } catch (error) {
    if (error instanceof WorkOSRequestError && error.status === 404) return null;
    throw error;
  }
}

async function closeLocalInvitation(
  db: D1Database,
  invitation: LocalInvitation,
  state: 'revoked' | 'expired' | 'failed',
  workosSyncStatus: 'synced' | 'pending',
  now: number,
): Promise<void> {
  await db.batch([
    db
      .prepare(
        `UPDATE hosted_organization_invitations
         SET state = ?, workos_sync_status = ?, updated_at = ?
         WHERE id = ? AND state IN ('creating', 'pending')`,
      )
      .bind(state, workosSyncStatus, now, invitation.id),
    db
      .prepare(
        `UPDATE hosted_team_seat_assignments SET state = 'released', updated_at = ?
         WHERE invitation_id = ? AND state = 'reserved'`,
      )
      .bind(now, invitation.id),
  ]);
}

async function revokeProviderInvitation(env: Env, invitationId: string): Promise<void> {
  const current = await providerInvitationById(env, invitationId);
  if (current === null || current.state !== 'pending') return;
  await workosRequest<unknown>(
    env,
    `/user_management/invitations/${encodeURIComponent(invitationId)}/revoke`,
    { method: 'POST', body: {} },
  );
}

async function applyAcceptedInvitation(
  env: Env,
  db: D1Database,
  local: LocalInvitation,
  provider: WorkOSInvitation,
  now: number,
): Promise<boolean> {
  if (
    local.workos_invitation_id === null ||
    provider.id !== local.workos_invitation_id ||
    provider.organization_id === null ||
    provider.state !== 'accepted' ||
    provider.accepted_user_id !== local.target_workos_user_id ||
    provider.organization_id !==
      (
        await db
          .prepare('SELECT workos_organization_id FROM hosted_organizations WHERE id = ?')
          .bind(local.organization_id)
          .first<{ workos_organization_id: string | null }>()
      )?.workos_organization_id ||
    normalizeEmail(provider.email) !== normalizeEmail(local.email)
  ) {
    return false;
  }
  if (local.state === 'accepted') return true;
  if (local.state !== 'pending' || local.expires_at <= now) return false;

  const activeProviderMembership = (
    await membershipsForUser(env, provider.organization_id, local.target_workos_user_id)
  ).find((membership) => membership.status === 'active');
  if (activeProviderMembership === undefined) return false;
  return completeHostedInvitationAcceptance(db, {
    invitationId: local.id,
    organizationId: local.organization_id,
    billingAccountId: local.target_billing_account_id,
    workosUserId: local.target_workos_user_id,
    email: local.email,
    providerMembershipId: activeProviderMembership.id,
    now,
  });
}

async function rejectAcceptedInvitation(
  env: Env,
  db: D1Database,
  local: LocalInvitation,
  provider: WorkOSInvitation,
  now: number,
): Promise<void> {
  if (local.state === 'pending' || local.state === 'creating') {
    await closeLocalInvitation(db, local, 'revoked', 'pending', now);
  }
  const org = await db
    .prepare('SELECT workos_organization_id FROM hosted_organizations WHERE id = ?')
    .bind(local.organization_id)
    .first<{ workos_organization_id: string | null }>();
  if (
    provider.organization_id === null ||
    provider.organization_id !== org?.workos_organization_id
  ) {
    return;
  }
  const memberships = await membershipsForUser(
    env,
    provider.organization_id,
    provider.accepted_user_id ?? '',
  );
  for (const membership of memberships) {
    await cleanupUnexpectedMembership(env, db, local.organization_id, membership);
  }
}

async function processInvitationTruth(
  env: Env,
  db: D1Database,
  local: LocalInvitation,
  provider: WorkOSInvitation | null,
  now: number,
): Promise<void> {
  if (provider === null) {
    if (local.state === 'pending' || local.state === 'creating') {
      await closeLocalInvitation(db, local, 'expired', 'synced', now);
    }
    return;
  }

  const org = await db
    .prepare('SELECT workos_organization_id FROM hosted_organizations WHERE id = ?')
    .bind(local.organization_id)
    .first<{ workos_organization_id: string | null }>();
  const matchesLocal =
    provider.organization_id !== null &&
    provider.organization_id === org?.workos_organization_id &&
    normalizeEmail(provider.email) === normalizeEmail(local.email);
  if (!matchesLocal) {
    if (provider.state === 'accepted') {
      await rejectAcceptedInvitation(env, db, local, provider, now);
    } else {
      if (provider.state === 'pending') await revokeProviderInvitation(env, provider.id);
      if (local.state === 'pending' || local.state === 'creating') {
        await closeLocalInvitation(db, local, 'revoked', 'synced', now);
      }
    }
    return;
  }

  if (provider.state === 'accepted') {
    const accepted = await applyAcceptedInvitation(env, db, local, provider, now);
    if (!accepted) await rejectAcceptedInvitation(env, db, local, provider, now);
    return;
  }

  if (provider.state === 'revoked' || provider.state === 'expired') {
    if (local.state === 'pending' || local.state === 'creating') {
      await closeLocalInvitation(db, local, provider.state, 'synced', now);
    }
    return;
  }

  if (local.state === 'revoked' || local.state === 'expired' || local.state === 'failed') {
    await revokeProviderInvitation(env, provider.id);
    await db
      .prepare(
        `UPDATE hosted_organization_invitations SET workos_sync_status = 'synced', updated_at = ?
         WHERE id = ? AND state IN ('revoked', 'expired', 'failed')`,
      )
      .bind(now, local.id)
      .run();
    return;
  }

  if (local.state === 'creating') {
    return;
  }
  if (local.expires_at <= now || Date.parse(provider.expires_at) <= now) {
    await revokeProviderInvitation(env, provider.id);
    await closeLocalInvitation(db, local, 'expired', 'synced', now);
  }
}

async function invitationEvent(
  env: Env,
  db: D1Database,
  data: Record<string, unknown>,
  now: number,
): Promise<void> {
  if (typeof data['id'] !== 'string') throw new WorkOSRequestError(400, false);
  const local = await invitationByProviderId(db, data['id']);
  if (local === null) return;
  const provider = await providerInvitationById(env, data['id']);
  await processInvitationTruth(env, db, local, provider, now);
}

async function findPendingInvitationForUser(
  db: D1Database,
  organizationId: string,
  userId: string,
  now: number,
): Promise<LocalInvitation | null> {
  return db
    .prepare(
      `SELECT * FROM hosted_organization_invitations
       WHERE organization_id = ? AND target_workos_user_id = ? AND state = 'pending'
         AND expires_at > ? AND workos_invitation_id IS NOT NULL
       ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(organizationId, userId, now)
    .first<LocalInvitation>();
}

async function membershipEvent(
  env: Env,
  db: D1Database,
  event: WorkOSEvent,
  now: number,
): Promise<void> {
  const workosMembershipId = event.data['id'];
  const workosOrganizationId = event.data['organization_id'];
  const workosUserId = event.data['user_id'];
  if (
    typeof workosMembershipId !== 'string' ||
    typeof workosOrganizationId !== 'string' ||
    typeof workosUserId !== 'string'
  ) {
    throw new WorkOSRequestError(400, false);
  }
  const organization = await getLocalOrganizationByWorkOSId(db, workosOrganizationId);
  if (organization === null) return;

  // Event payloads can be old or reordered. Fetch current provider truth for
  // every membership event instead of applying the event snapshot.
  const provider = await providerMembershipById(env, workosMembershipId);
  let local = await membershipByProviderId(db, workosMembershipId);
  if (local === null && organization.status === 'closed') {
    // Closing an organization clears provider membership IDs while retaining
    // active owners for billing recovery. A delayed membership webhook can
    // still identify that preserved owner by the event's user ID.
    local = await membershipByIdentity(db, organization.id, workosUserId);
  }
  if (provider === null) {
    if (local !== null) {
      if (
        local.role === 'owner' &&
        local.status === 'active' &&
        (await closeOrganizationIfProviderDeleted(env, db, organization, now))
      ) {
        return;
      }
      if (organization.status === 'closed' && isBillingOnlyOwner(local)) {
        await retainBillingOwnerAndReleaseSeat(db, local, now, 'synced');
      } else {
        await releaseMembershipSeat(db, local, now);
      }
    }
    return;
  }
  if (provider.organization_id !== workosOrganizationId || provider.user_id !== workosUserId) {
    throw new WorkOSRequestError(502, true);
  }

  if (provider.status !== 'active') {
    if (local !== null) {
      if (
        local.role === 'owner' &&
        local.status === 'active' &&
        (await closeOrganizationIfProviderDeleted(env, db, organization, now))
      ) {
        return;
      }
      if (organization.status === 'closed' && isBillingOnlyOwner(local)) {
        await retainBillingOwnerAndReleaseSeat(db, local, now, 'synced');
      } else {
        await releaseMembershipSeat(db, local, now);
      }
    }
    return;
  }

  if (local === null) {
    // An accepted invitation event can be delivered after membership.updated.
    // Resolve a matching local reservation from current invitation truth;
    // never create a member just because WorkOS reports an active membership.
    const pending = await findPendingInvitationForUser(db, organization.id, workosUserId, now);
    if (pending !== null && pending.workos_invitation_id !== null) {
      const invitation = await providerInvitationById(env, pending.workos_invitation_id);
      if (invitation !== null && invitation.state === 'accepted') {
        await processInvitationTruth(env, db, pending, invitation, now);
        local = await membershipByProviderId(db, workosMembershipId);
      }
    }
  }

  if (local === null) {
    await cleanupUnexpectedMembership(env, db, organization.id, provider);
    return;
  }
  if (local.organization_id !== organization.id || local.workos_user_id !== workosUserId) {
    throw new WorkOSRequestError(502, true);
  }
  if (local.status !== 'active') {
    await releaseMembershipSeat(db, local, now, 'pending');
    await deactivateOrDeleteProviderMembership(env, provider);
    await setMembershipSyncStatus(db, local, 'synced', now);
    return;
  }

  const expectedRole = expectedWorkOSRole(local.role);
  if (provider.role_slug !== expectedRole) {
    await setMembershipSyncStatus(db, local, 'pending', now);
    await workosRequest<unknown>(
      env,
      `/user_management/organization_memberships/${encodeURIComponent(provider.id)}`,
      { method: 'PUT', body: { role_slug: expectedRole } },
    );
  }
  await setMembershipSyncStatus(db, local, 'synced', now);
}

async function organizationDeletedEvent(
  env: Env,
  db: D1Database,
  data: Record<string, unknown>,
  now: number,
): Promise<void> {
  if (typeof data['id'] !== 'string') throw new WorkOSRequestError(400, false);
  const local = await getLocalOrganizationByWorkOSId(db, data['id']);
  if (local === null) return;
  try {
    await workosRequest<unknown>(env, `/organizations/${encodeURIComponent(data['id'])}`);
    // A delayed delete event after a re-created resource is harmless: current
    // WorkOS state remains authoritative.
    return;
  } catch (error) {
    if (!(error instanceof WorkOSRequestError) || error.status !== 404) throw error;
  }
  await closeOrganization(db, local.id, now);
}

async function closeOrganizationIfProviderDeleted(
  env: Env,
  db: D1Database,
  organization: LocalOrganization,
  now: number,
): Promise<boolean> {
  try {
    await workosRequest<unknown>(
      env,
      `/organizations/${encodeURIComponent(organization.workos_organization_id)}`,
    );
    return false;
  } catch (error) {
    if (!(error instanceof WorkOSRequestError) || error.status !== 404) throw error;
    await closeOrganization(db, organization.id, now);
    return true;
  }
}

async function closeOrganization(
  db: D1Database,
  organizationId: string,
  now: number,
): Promise<void> {
  await db.batch([
    db
      .prepare(
        `UPDATE hosted_organizations SET status = 'closed', updated_at = ?
         WHERE id = ? AND status != 'closed'`,
      )
      .bind(now, organizationId),
    db
      .prepare(
        `UPDATE hosted_organization_memberships
         SET status = CASE WHEN role = 'owner' THEN status ELSE 'inactive' END,
             seat_opted_out = CASE WHEN role = 'owner' AND status = 'active' THEN 1 ELSE seat_opted_out END,
             workos_membership_id = NULL, workos_sync_status = 'synced', updated_at = ?
         WHERE organization_id = ?`,
      )
      .bind(now, organizationId),
    db
      .prepare(
        `UPDATE hosted_team_seat_assignments SET state = 'released', updated_at = ?
         WHERE organization_id = ? AND state IN ('reserved', 'assigned')`,
      )
      .bind(now, organizationId),
    db
      .prepare(
        `UPDATE hosted_organization_invitations
         SET state = CASE WHEN state IN ('creating', 'pending') THEN 'revoked' ELSE state END,
             workos_sync_status = 'synced', updated_at = ?
         WHERE organization_id = ?`,
      )
      .bind(now, organizationId),
    db
      .prepare(
        `UPDATE organization_billing_state SET effective_seat_capacity = 0, updated_at = ?
         WHERE organization_id = ?`,
      )
      .bind(now, organizationId),
  ]);
}

async function processEvent(env: Env, db: D1Database, event: WorkOSEvent): Promise<void> {
  const now = Date.now();
  switch (event.event) {
    case 'organization_membership.updated':
    case 'organization_membership.deleted':
      return membershipEvent(env, db, event, now);
    case 'invitation.accepted':
    case 'invitation.revoked':
      return invitationEvent(env, db, event.data, now);
    case 'organization.deleted':
      return organizationDeletedEvent(env, db, event.data, now);
    default:
      return;
  }
}

/** Public WorkOS webhook. Signature verification uses the raw body before JSON parsing. */
export async function handleHostedOrganizationWebhook(
  request: Request,
  env: Env,
  db: D1Database,
): Promise<Response> {
  if (request.method !== 'POST') return new Response(null, { status: 405 });
  const secret = env.WORKOS_WEBHOOK_SECRET;
  if (typeof secret !== 'string' || secret.length === 0)
    return rpcErrorResponse(undefined, 'not-found');
  const declaredLength = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declaredLength) && declaredLength > WEBHOOK_BODY_MAX_BYTES) {
    return rpcErrorResponse(undefined, 'payload-too-large');
  }
  let rawBody: string;
  try {
    const reader = request.body?.getReader();
    if (reader === undefined) return rpcErrorResponse(undefined, 'malformed-request');
    const chunks: Uint8Array[] = [];
    let byteLength = 0;
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      byteLength += next.value.byteLength;
      if (byteLength > WEBHOOK_BODY_MAX_BYTES) {
        await reader.cancel();
        return rpcErrorResponse(undefined, 'payload-too-large');
      }
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    rawBody = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return rpcErrorResponse(undefined, 'malformed-request');
  }
  const signature = request.headers.get('workos-signature') ?? '';
  if (!(await verifyWorkOSSignature(rawBody, signature, secret, Date.now()))) {
    return rpcErrorResponse(undefined, 'unauthenticated');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody) as unknown;
  } catch {
    return rpcErrorResponse(undefined, 'malformed-request');
  }
  const event = parseEvent(parsed);
  if (event === null) return rpcErrorResponse(undefined, 'malformed-request');

  const now = Date.now();
  await db
    .prepare(
      `INSERT OR IGNORE INTO hosted_workos_webhook_events
       (workos_event_id, status, created_at, processed_at) VALUES (?, 'pending', ?, NULL)`,
    )
    .bind(event.id, now)
    .run();
  const stored = await db
    .prepare('SELECT status FROM hosted_workos_webhook_events WHERE workos_event_id = ?')
    .bind(event.id)
    .first<{ status: 'pending' | 'processed' }>();
  if (stored?.status === 'processed') return Response.json({ received: true, duplicate: true });

  try {
    await processEvent(env, db, event);
    await db
      .prepare(
        `UPDATE hosted_workos_webhook_events SET status = 'processed', processed_at = ?
         WHERE workos_event_id = ?`,
      )
      .bind(Date.now(), event.id)
      .run();
    return Response.json({ received: true });
  } catch {
    // Leave the event pending. WorkOS retries this webhook, and the hourly
    // reconciler also repairs provider/local drift after transient failures.
    return rpcErrorResponse(undefined, 'unavailable');
  }
}

async function listProviderPages<T>(
  env: Env,
  path: string,
  parse: (value: unknown) => T | null,
): Promise<T[]> {
  const values: T[] = [];
  let after: string | null = null;
  const seenCursors = new Set<string>();
  for (;;) {
    const url = new URL(path, 'https://api.workos.com');
    url.searchParams.set('limit', String(WORKOS_PAGE_SIZE));
    if (after !== null) url.searchParams.set('after', after);
    const response = await workosRequest<unknown>(env, `${url.pathname}${url.search}`);
    if (!isRecord(response) || !Array.isArray(response.data)) {
      throw new WorkOSRequestError(502, true);
    }
    for (const item of response.data) {
      const value = parse(item);
      if (value === null) throw new WorkOSRequestError(502, true);
      values.push(value);
    }
    const metadata = isRecord(response.list_metadata) ? response.list_metadata : null;
    const next = typeof metadata?.['after'] === 'string' ? metadata['after'] : null;
    if (next === null) break;
    if (response.data.length === 0 || seenCursors.has(next)) {
      // An incomplete provider snapshot must not be treated as authoritative;
      // otherwise reconciliation could revoke local seats absent from a
      // truncated or cyclic page sequence.
      throw new WorkOSRequestError(502, true);
    }
    seenCursors.add(next);
    after = next;
  }
  return values;
}

async function listProviderMemberships(
  env: Env,
  organizationId: string,
): Promise<WorkOSMembership[]> {
  const url = new URL('/user_management/organization_memberships', 'https://api.workos.com');
  url.searchParams.set('organization_id', organizationId);
  url.searchParams.set('statuses', 'active,inactive,pending');
  return listProviderPages(env, `${url.pathname}${url.search}`, parseMembership);
}

async function listProviderInvitations(
  env: Env,
  organizationId: string,
): Promise<WorkOSInvitation[]> {
  const url = new URL('/user_management/invitations', 'https://api.workos.com');
  url.searchParams.set('organization_id', organizationId);
  return listProviderPages(env, `${url.pathname}${url.search}`, parseInvitation);
}

async function retryMembershipMutation(
  env: Env,
  db: D1Database,
  local: LocalMembership,
  workosOrganizationId: string,
  provider: WorkOSMembership | undefined,
  now: number,
): Promise<void> {
  if (
    provider === undefined ||
    provider.organization_id !== workosOrganizationId ||
    provider.user_id !== local.workos_user_id
  ) {
    await releaseMembershipSeat(db, local, now);
    return;
  }
  if (local.status === 'inactive') {
    await releaseMembershipSeat(db, local, now, 'pending');
    await deactivateOrDeleteProviderMembership(env, provider);
    await setMembershipSyncStatus(db, local, 'synced', now);
    return;
  }
  if (provider.status !== 'active') {
    await releaseMembershipSeat(db, local, now);
    return;
  }
  if (provider.role_slug !== expectedWorkOSRole(local.role)) {
    await workosRequest<unknown>(
      env,
      `/user_management/organization_memberships/${encodeURIComponent(provider.id)}`,
      { method: 'PUT', body: { role_slug: expectedWorkOSRole(local.role) } },
    );
  }
  await setMembershipSyncStatus(db, local, 'synced', now);
}

async function reconcileInvitation(
  env: Env,
  db: D1Database,
  local: LocalInvitation,
  providerById: Map<string, WorkOSInvitation>,
  now: number,
): Promise<void> {
  if (local.workos_invitation_id === null) {
    if (local.state === 'creating' && local.updated_at + STALE_CREATE_MS <= now) {
      await closeLocalInvitation(db, local, 'failed', 'synced', now);
    }
    return;
  }
  const provider = providerById.get(local.workos_invitation_id) ?? null;
  if (local.state === 'revoked' || local.state === 'expired' || local.state === 'failed') {
    if (provider?.state === 'accepted') {
      await processInvitationTruth(env, db, local, provider, now);
    } else {
      if (provider?.state === 'pending') await revokeProviderInvitation(env, provider.id);
      await db
        .prepare(
          `UPDATE hosted_organization_invitations SET workos_sync_status = 'synced', updated_at = ?
           WHERE id = ? AND state IN ('revoked', 'expired', 'failed')`,
        )
        .bind(now, local.id)
        .run();
    }
    return;
  }
  if (local.state === 'pending' && local.expires_at <= now && provider?.state === 'pending') {
    await revokeProviderInvitation(env, provider.id);
    await closeLocalInvitation(db, local, 'expired', 'synced', now);
    return;
  }
  await processInvitationTruth(env, db, local, provider, now);
}

async function reconcileOrganization(
  env: Env,
  db: D1Database,
  organization: LocalOrganization,
  now: number,
): Promise<void> {
  try {
    await workosRequest<unknown>(
      env,
      `/organizations/${encodeURIComponent(organization.workos_organization_id)}`,
    );
  } catch (error) {
    if (error instanceof WorkOSRequestError && error.status === 404) {
      await closeOrganization(db, organization.id, now);
      return;
    }
    throw error;
  }

  const [providerInvitations, providerMemberships] = await Promise.all([
    listProviderInvitations(env, organization.workos_organization_id),
    listProviderMemberships(env, organization.workos_organization_id),
  ]);
  if (
    providerMemberships.some(
      (membership) => membership.organization_id !== organization.workos_organization_id,
    ) ||
    providerInvitations.some(
      (invitation) => invitation.organization_id !== organization.workos_organization_id,
    )
  ) {
    throw new WorkOSRequestError(502, true);
  }
  const invitationById = new Map(
    providerInvitations.map((invitation) => [invitation.id, invitation]),
  );
  const membershipById = new Map(
    providerMemberships.map((membership) => [membership.id, membership]),
  );

  const localInvitationsResult = await db
    .prepare(
      `SELECT * FROM hosted_organization_invitations
       WHERE organization_id = ? AND state IN ('creating', 'pending', 'accepted', 'revoked', 'expired', 'failed')
       ORDER BY created_at, id`,
    )
    .bind(organization.id)
    .all<LocalInvitation>();
  for (const invitation of localInvitationsResult.results ?? []) {
    await reconcileInvitation(env, db, invitation, invitationById, now);
  }

  const localMembershipsResult = await db
    .prepare(
      `SELECT organization_id, billing_account_id, workos_user_id,
              workos_membership_id, role, status, seat_opted_out, workos_sync_status
       FROM hosted_organization_memberships WHERE organization_id = ? ORDER BY workos_user_id`,
    )
    .bind(organization.id)
    .all<LocalMembership>();
  const localMembers = localMembershipsResult.results ?? [];
  const localByProviderId = new Map(
    localMembers
      .filter((member) => member.workos_membership_id !== null)
      .map((member) => [member.workos_membership_id as string, member]),
  );

  if (organization.status === 'closed') {
    for (const provider of providerMemberships) {
      const local =
        localByProviderId.get(provider.id) ??
        (await membershipByIdentity(db, organization.id, provider.user_id));
      if (provider.status === 'inactive') {
        if (local !== null && isBillingOnlyOwner(local)) {
          await retainBillingOwnerAndReleaseSeat(db, local, now, 'synced');
        } else if (local !== null) {
          await releaseMembershipSeat(db, local, now);
        }
        continue;
      }

      if (local !== null && isBillingOnlyOwner(local)) {
        await retainBillingOwnerAndReleaseSeat(db, local, now, 'pending');
        await deactivateOrDeleteProviderMembership(env, provider);
        await setMembershipSyncStatus(db, local, 'synced', now);
      } else if (local !== null) {
        await releaseMembershipSeat(db, local, now, 'pending');
        await deactivateOrDeleteProviderMembership(env, provider);
        await setMembershipSyncStatus(db, local, 'synced', now);
      } else {
        await cleanupUnexpectedMembership(env, db, organization.id, provider);
      }
    }

    for (const local of localMembers) {
      if (isBillingOnlyOwner(local)) {
        await retainBillingOwnerAndReleaseSeat(db, local, now, 'synced');
      } else if (local.status === 'active' || local.workos_sync_status === 'pending') {
        await releaseMembershipSeat(db, local, now);
      }
    }

    await db
      .prepare(
        `UPDATE hosted_team_seat_assignments SET state = 'released', updated_at = ?
         WHERE organization_id = ? AND state = 'reserved' AND expires_at <= ?`,
      )
      .bind(now, organization.id, now)
      .run();
    return;
  }

  for (const provider of providerMemberships) {
    const local = localByProviderId.get(provider.id) ?? null;
    if (local !== null) {
      if (provider.status !== 'active') {
        await releaseMembershipSeat(db, local, now);
      } else if (local.status === 'inactive') {
        await releaseMembershipSeat(db, local, now, 'pending');
        await deactivateOrDeleteProviderMembership(env, provider);
        await setMembershipSyncStatus(db, local, 'synced', now);
      } else {
        await retryMembershipMutation(
          env,
          db,
          local,
          organization.workos_organization_id,
          provider,
          now,
        );
      }
      continue;
    }

    // A locally accepted invitation may have just assigned a new provider id.
    // Reload by target identity before treating this as unsolicited.
    const localByIdentity = await membershipByIdentity(db, organization.id, provider.user_id);
    if (localByIdentity !== null && localByIdentity.status === 'active') {
      if (localByIdentity.workos_membership_id !== provider.id) {
        await db
          .prepare(
            `UPDATE hosted_organization_memberships SET workos_membership_id = ?, updated_at = ?
             WHERE organization_id = ? AND workos_user_id = ? AND status = 'active'
               AND workos_membership_id IS NULL`,
          )
          .bind(provider.id, now, organization.id, provider.user_id)
          .run();
      }
      const expectedRole = expectedWorkOSRole(localByIdentity.role);
      if (provider.status === 'active' && provider.role_slug !== expectedRole) {
        await workosRequest<unknown>(
          env,
          `/user_management/organization_memberships/${encodeURIComponent(provider.id)}`,
          { method: 'PUT', body: { role_slug: expectedRole } },
        );
      }
      continue;
    }
    if (provider.status === 'active') {
      await cleanupUnexpectedMembership(env, db, organization.id, provider);
    } else if (provider.status === 'pending') {
      const knownPendingInvitation = localInvitationsResult.results?.some(
        (invitation) =>
          invitation.state === 'pending' &&
          invitation.target_workos_user_id === provider.user_id &&
          invitation.workos_invitation_id !== null &&
          providerInvitations.some(
            (providerInvitation) =>
              providerInvitation.id === invitation.workos_invitation_id &&
              providerInvitation.organization_id === organization.workos_organization_id &&
              providerInvitation.state === 'pending',
          ),
      );
      if (!knownPendingInvitation) await deactivateOrDeleteProviderMembership(env, provider);
    }
  }

  // WorkOS can hard-delete a membership without a usable GET response. Any
  // local active row absent from the full all-status listing loses its seat.
  for (const local of localMembers) {
    if (local.workos_membership_id !== null && !membershipById.has(local.workos_membership_id)) {
      await releaseMembershipSeat(db, local, now);
    } else if (local.workos_membership_id === null && local.status === 'active') {
      // An active local member without a provider membership cannot sponsor
      // access. The user can rejoin through a fresh accepted invitation.
      await releaseMembershipSeat(db, local, now);
    }
  }

  const nowLocal = await db
    .prepare(
      `UPDATE hosted_team_seat_assignments SET state = 'released', updated_at = ?
       WHERE organization_id = ? AND state = 'reserved' AND expires_at <= ?`,
    )
    .bind(now, organization.id, now)
    .run();
  void nowLocal;
}

/** Hourly provider-to-local organization reconciliation. */
export async function runHostedOrganizationReconcile(env: Env): Promise<void> {
  const db = env.HOSTED_DB;
  if (db === undefined) return;
  let cursor: string | null = null;
  let failures = 0;
  const failedOrganizationIds: string[] = [];
  for (;;) {
    const page: { results?: LocalOrganization[] } = await db
      .prepare(
        `SELECT id, workos_organization_id, status FROM hosted_organizations
         WHERE workos_organization_id IS NOT NULL
           AND (status = 'active' OR (status = 'closed' AND (
             EXISTS (SELECT 1 FROM hosted_organization_memberships m
                     WHERE m.organization_id = hosted_organizations.id
                       AND m.workos_sync_status = 'pending')
             OR EXISTS (SELECT 1 FROM hosted_organization_invitations i
                        WHERE i.organization_id = hosted_organizations.id
                          AND i.workos_sync_status = 'pending')
           )))
           AND (? IS NULL OR id > ?)
         ORDER BY id LIMIT ?`,
      )
      .bind(cursor, cursor, LOCAL_ORG_PAGE_SIZE)
      .all<LocalOrganization>();
    const organizations: LocalOrganization[] = page.results ?? [];
    if (organizations.length === 0) break;
    for (const organization of organizations) {
      try {
        await reconcileOrganization(env, db, organization, Date.now());
      } catch (error) {
        failures += 1;
        if (failedOrganizationIds.length < 20) failedOrganizationIds.push(organization.id);
        console.error('Hosted WorkOS organization reconciliation failed', {
          organizationId: organization.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const lastOrganization: LocalOrganization | undefined = organizations[organizations.length - 1];
    if (lastOrganization === undefined || organizations.length < LOCAL_ORG_PAGE_SIZE) break;
    cursor = lastOrganization.id;
  }
  if (failures > 0) {
    console.error('Hosted WorkOS organization reconciliation completed with failures', {
      failures,
      failedOrganizationIds,
    });
    throw new WorkOSRequestError(502, true);
  }
}
