import type { ShareAudience } from '../../../contract/shares';
import { isRecord } from '../rpc';
import { validateHostedIdentity, type HostedIdentity } from './identity';
import { findBillingBySyncAccount, type BillingAccountRow } from './store';

/** A configured signed viewer channel and its authoritative identity directory. */
export function shareAudiencesAvailable(env: {
  HOSTED_DB?: unknown;
  HOSTED_WORKOS_CLIENT_ID?: string;
  HOSTED_SERVICE_KEYS?: string;
}): boolean {
  if (
    env.HOSTED_DB === undefined ||
    !/^client_[A-Za-z0-9_-]{1,240}$/.test(env.HOSTED_WORKOS_CLIENT_ID ?? '')
  )
    return false;
  try {
    const keys: unknown = JSON.parse(env.HOSTED_SERVICE_KEYS ?? '');
    return (
      isRecord(keys) &&
      Object.keys(keys).length > 0 &&
      Object.entries(keys).every(
        ([id, secret]) =>
          /^[A-Za-z0-9_-]{1,64}$/.test(id) &&
          typeof secret === 'string' &&
          new TextEncoder().encode(secret).byteLength >= 32,
      )
    );
  } catch {
    return false;
  }
}

export function parseShareAudience(value: unknown): ShareAudience | null {
  if (value === undefined) return { kind: 'link' };
  if (!isRecord(value)) return null;
  if (value.kind === 'link' && Object.keys(value).length === 1) return { kind: 'link' };
  if (
    value.kind === 'organization' &&
    Object.keys(value).length === 2 &&
    typeof value.organizationId === 'string' &&
    /^[A-Za-z0-9_-]{1,128}$/.test(value.organizationId)
  ) {
    return { kind: 'organization', organizationId: value.organizationId };
  }
  return null;
}

/** The verified sync account determines author identity; request identity fields are never used. */
export async function shareAuthorAccount(
  env: Env,
  accountId: string,
): Promise<BillingAccountRow | null> {
  if (!shareAudiencesAvailable(env) || env.HOSTED_DB === undefined) return null;
  const account = await findBillingBySyncAccount(env.HOSTED_DB, accountId);
  return account?.lifecycle === 'active' && account.workos_client_id === env.HOSTED_WORKOS_CLIENT_ID
    ? account
    : null;
}

/** Local active membership is authoritative, including pending provider-sync removals. No seat check. */
export async function shareOrganizationsForAccount(
  db: D1Database,
  account: BillingAccountRow,
): Promise<Array<{ id: string; name: string }>> {
  const result = await db
    .prepare(
      `SELECT o.id, o.name FROM hosted_organizations o
     JOIN hosted_organization_memberships m ON m.organization_id = o.id
     JOIN billing_accounts b ON b.id = m.billing_account_id
     WHERE b.id = ? AND b.lifecycle = 'active'
       AND m.workos_client_id = b.workos_client_id AND m.workos_user_id = b.workos_user_id
       AND m.status = 'active' AND o.status = 'active'
     ORDER BY o.name, o.id`,
    )
    .bind(account.id)
    .all<{ id: string; name: string }>();
  return result.results;
}

export async function canReadOrganizationShare(
  env: Env,
  organizationId: string,
  identity: unknown,
): Promise<boolean> {
  if (
    !shareAudiencesAvailable(env) ||
    env.HOSTED_DB === undefined ||
    !validateHostedIdentity(identity) ||
    identity.workosClientId !== env.HOSTED_WORKOS_CLIENT_ID
  )
    return false;
  return activeOrganizationMember(env.HOSTED_DB, organizationId, identity);
}

export async function activeOrganizationMember(
  db: D1Database,
  organizationId: string,
  identity: HostedIdentity,
): Promise<boolean> {
  const member = await db
    .prepare(
      `SELECT 1 AS allowed FROM hosted_organization_memberships m
     JOIN hosted_organizations o ON o.id = m.organization_id
     JOIN billing_accounts b ON b.id = m.billing_account_id
     WHERE o.id = ? AND o.status = 'active' AND m.status = 'active'
       AND b.lifecycle = 'active' AND m.workos_client_id = ? AND m.workos_user_id = ?
       AND b.workos_client_id = m.workos_client_id AND b.workos_user_id = m.workos_user_id`,
    )
    .bind(organizationId, identity.workosClientId, identity.workosUserId)
    .first();
  return member !== null;
}
