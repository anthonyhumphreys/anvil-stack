import { validateHostedIdentity, type HostedIdentity } from './identity';
import { workosRequest, WorkOSRequestError } from './workos';
import {
  getBillingAccountByIdentity,
  getOrCreateBillingAccount,
  type BillingAccountRow,
} from './store';

interface WorkOSUser {
  id: string;
  email: string;
  email_verified: boolean;
}

interface WorkOSWaitlistEntries {
  data: unknown[];
}

function normalizedEmail(email: string): string {
  return email.trim().toLowerCase();
}

function expectedHostedClient(env: Env, identity: HostedIdentity): boolean {
  return (
    typeof env.HOSTED_WORKOS_CLIENT_ID === 'string' &&
    identity.workosClientId === env.HOSTED_WORKOS_CLIENT_ID
  );
}

/**
 * Looks up the user's verified email through WorkOS, then checks the default
 * WorkOS waitlist for an exact approved entry. Caller-supplied email values
 * are never used as admission evidence.
 */
async function hasApprovedWaitlistEntry(env: Env, identity: HostedIdentity): Promise<boolean> {
  if (!validateHostedIdentity(identity) || !expectedHostedClient(env, identity)) return false;

  let user: WorkOSUser;
  try {
    user = await workosRequest<WorkOSUser>(
      env,
      `/user_management/users/${encodeURIComponent(identity.workosUserId)}`,
    );
  } catch (error) {
    // A stale/nonexistent WorkOS subject is an admission denial. Other
    // provider failures surface so callers can fail closed as unavailable.
    if (error instanceof WorkOSRequestError && error.status === 404) return false;
    throw error;
  }

  if (
    user.id !== identity.workosUserId ||
    typeof user.email !== 'string' ||
    user.email.trim().length === 0 ||
    user.email_verified !== true
  ) {
    return false;
  }

  if (operatorAdmissionAllowed(env, user.id)) return true;

  const email = normalizedEmail(user.email);
  const query = new URLSearchParams({ state: 'approved', email, limit: '10' });
  const entries = await workosRequest<WorkOSWaitlistEntries>(
    env,
    `/user_management/waitlists/default/entries?${query.toString()}`,
  );
  if (!Array.isArray(entries.data)) return false;

  return entries.data.some((entry) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return false;
    const candidate = entry as Record<string, unknown>;
    return (
      candidate['state'] === 'approved' &&
      typeof candidate['email'] === 'string' &&
      normalizedEmail(candidate['email']) === email
    );
  });
}

/**
 * Temporary, exact-id bridge for existing WorkOS users who predate the
 * hosted billing row and therefore cannot be admitted through a waitlist
 * entry. The id is still fetched from this deployment's WorkOS environment
 * and its email must be verified before this override is honored.
 */
function operatorAdmissionAllowed(env: Env, workosUserId: string): boolean {
  const configured = env.HOSTED_ADMITTED_WORKOS_USER_IDS;
  if (configured === undefined) return false;

  let ids: unknown;
  try {
    ids = JSON.parse(configured) as unknown;
  } catch {
    return false;
  }
  if (
    !Array.isArray(ids) ||
    ids.length > 1_000 ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => typeof id !== 'string' || !/^user_[A-Za-z0-9_-]{1,240}$/.test(id))
  ) {
    return false;
  }
  return ids.includes(workosUserId);
}

/**
 * Existing active hosted accounts are grandfathered. A new WorkOS identity
 * must have a verified email with an exact approved entry on this WorkOS
 * environment's default waitlist.
 */
export async function isHostedIdentityAdmitted(
  env: Env,
  db: D1Database,
  identity: HostedIdentity,
): Promise<boolean> {
  if (!validateHostedIdentity(identity) || !expectedHostedClient(env, identity)) return false;

  const existing = await getBillingAccountByIdentity(db, identity);
  if (existing !== null) return existing.lifecycle === 'active';

  return hasApprovedWaitlistEntry(env, identity);
}

/**
 * Creates the durable hosted billing identity only after WorkOS confirms
 * admission. The billing row is the persisted first-admission record used
 * by later website and desktop requests.
 */
export async function getOrCreateAdmittedBillingAccount(
  env: Env,
  db: D1Database,
  identity: HostedIdentity,
): Promise<BillingAccountRow | null> {
  if (!validateHostedIdentity(identity) || !expectedHostedClient(env, identity)) return null;

  const existing = await getBillingAccountByIdentity(db, identity);
  if (existing !== null) return existing;
  if (!(await hasApprovedWaitlistEntry(env, identity))) return null;

  return getOrCreateBillingAccount(db, identity);
}
