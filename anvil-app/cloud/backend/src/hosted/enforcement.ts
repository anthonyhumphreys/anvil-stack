import type { HostedEntitlement } from '../../../contract/entitlements';
import { getEntitlement, resolveHostedLimits } from './billing';
import { evaluateHostedEntitlement, freeHostedEntitlement } from './policy';
import { findBillingBySyncAccount } from './store';
import { stripeConfigured } from './stripe';

export const ENTITLEMENT_CACHE_TTL_MS = 60 * 1000;
export const TEAM_ENTITLEMENT_CACHE_TTL_MS = ENTITLEMENT_CACHE_TTL_MS;

export type HostedAccess =
  | { allowed: true; entitlement: HostedEntitlement | null }
  | { allowed: false; entitlement: HostedEntitlement | null; reason: string };

export function hostedEnforcementEnabled(env: Env): boolean {
  return env.HOSTED_BILLING_ENFORCEMENT === 'true';
}

export function hostedConfigIssues(env: Env): string[] {
  if (!hostedEnforcementEnabled(env)) return [];
  const missing: string[] = [];
  if (env.HOSTED_DB === undefined) missing.push('HOSTED_DB');
  if (typeof env.HOSTED_SERVICE_KEYS !== 'string' || env.HOSTED_SERVICE_KEYS.length === 0) {
    missing.push('HOSTED_SERVICE_KEYS');
  }
  return missing;
}

export function unavailableHostedEntitlement(env: Env, now: number): HostedEntitlement {
  return evaluateHostedEntitlement({
    now,
    lifecycle: 'active',
    previewEligible: false,
    revision: 0,
    limits: resolveHostedLimits(env),
    subscriptions: [],
    billingUnavailable: true,
    renewalGraceDays: 0,
    outageGraceHours: 0,
  });
}

export async function resolveAccountEntitlement(
  env: Env,
  accountId: string,
  now: number,
): Promise<HostedEntitlement> {
  const limits = resolveHostedLimits(env);
  if (!hostedEnforcementEnabled(env)) return freeHostedEntitlement(now, limits);
  const db = env.HOSTED_DB;
  if (db === undefined) return unavailableHostedEntitlement(env, now);
  const billing = await findBillingBySyncAccount(db, accountId);
  if (billing === null)
    return evaluateHostedEntitlement({
      now,
      lifecycle: 'active',
      previewEligible: false,
      revision: 0,
      limits,
      subscriptions: [],
      billingUnavailable: false,
      renewalGraceDays: 0,
      outageGraceHours: 0,
    });
  return getEntitlement(db, billing, now, limits, !stripeConfigured(env));
}

export async function checkHostedAccess(
  env: Env,
  accountId: string,
  now: number,
): Promise<HostedAccess> {
  if (!hostedEnforcementEnabled(env)) return { allowed: true, entitlement: null };
  try {
    const entitlement = await resolveAccountEntitlement(env, accountId, now);
    return entitlement.capabilities.syncWrite && entitlement.capabilities.meshSubmit
      ? { allowed: true, entitlement }
      : { allowed: false, entitlement, reason: entitlement.reason };
  } catch {
    return { allowed: false, entitlement: null, reason: 'billing-unavailable' };
  }
}
