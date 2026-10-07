// Hosted device-limit enforcement and the current Sync/Mesh access snapshot.
// Sync and Mesh are free for active hosted accounts; subscription state is
// billing history and never authorizes or denies their writes. Account
// lifecycle, device limits, operation auth, quotas, and fair-use restrictions
// remain enforced at their existing boundaries.

import type { HostedEntitlement } from '../../../contract/entitlements';
import { resolveHostedLimits } from './billing';
import { freeHostedEntitlement } from './policy';
import { findBillingBySyncAccount } from './store';

/** Retained export for existing enforcement tests and consumers during rollout. */
export const ENTITLEMENT_CACHE_TTL_MS = 60 * 1000;
export const TEAM_ENTITLEMENT_CACHE_TTL_MS = ENTITLEMENT_CACHE_TTL_MS;

export type HostedAccess =
  | { allowed: true; entitlement: null }
  | { allowed: false; entitlement: null; reason: string };

/**
 * This legacy switch now controls the hosted device-limit preflight. It does
 * not gate Sync or Mesh on billing and is inert for self-hosted deployments.
 */
export function hostedEnforcementEnabled(env: Env): boolean {
  return env.HOSTED_BILLING_ENFORCEMENT === 'true' && env.HOSTED_DB !== undefined;
}

/**
 * Sanity check for deployments that enable the hosted device-limit preflight:
 * billing identity and the service surface must both be configured.
 */
export function hostedConfigIssues(env: Env): string[] {
  if (env.HOSTED_BILLING_ENFORCEMENT !== 'true') return [];
  const missing: string[] = [];
  if (env.HOSTED_DB === undefined) missing.push('HOSTED_DB');
  if (typeof env.HOSTED_SERVICE_KEYS !== 'string' || env.HOSTED_SERVICE_KEYS.length === 0) {
    missing.push('HOSTED_SERVICE_KEYS');
  }
  return missing;
}

/**
 * Resolve the free capability snapshot. The hosted account row is consulted
 * only for its deletion lifecycle; subscription, preview, and Stripe state
 * do not affect Sync or Mesh capabilities.
 */
export async function resolveAccountEntitlement(
  env: Env,
  accountId: string,
  now: number,
): Promise<HostedEntitlement> {
  const limits = resolveHostedLimits(env);
  const db = env.HOSTED_DB;
  if (db === undefined) return freeHostedEntitlement(now, limits);
  const billing = await findBillingBySyncAccount(db, accountId);
  return freeHostedEntitlement(now, limits, billing?.lifecycle ?? 'active', billing?.updated_at ?? 0);
}

/**
 * Sync and Mesh writes are always free for an authenticated account. This
 * check intentionally does not read the billing database, so an absent
 * subscription, a canceled legacy subscription, preview expiration, or a
 * Stripe/D1 outage cannot deny them. Hosted device limits are checked by the
 * caller through the session coordinator.
 */
export async function checkHostedAccess(
  _storage: DurableObjectStorage,
  _env: Env,
  _accountId: string,
  _now: number,
): Promise<HostedAccess> {
  return { allowed: true, entitlement: null };
}
