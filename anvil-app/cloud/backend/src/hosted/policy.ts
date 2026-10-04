import type { HostedEntitlement, HostedLimits } from '../../../contract/entitlements';

/** Retained for wire compatibility with clients that display the old preview deadline. */
export const PREVIEW_ENDS_AT = '2026-11-01T00:00:00.000Z';
export const PREVIEW_END_MS = Date.parse(PREVIEW_ENDS_AT);
const MAX_DATE_MS = 8_640_000_000_000_000;

/** Hosted limits: up to five devices; storage and history follow fair-use policy. */
export const DEFAULT_HOSTED_LIMITS: HostedLimits = {
  devices: 5,
  artifactBytes: null,
  historyBytes: null,
};

export interface HostedSubscriptionState {
  planKey: 'sync_personal' | 'sync_team';
  status:
    | 'active'
    | 'past_due'
    | 'incomplete'
    | 'incomplete_expired'
    | 'canceled'
    | 'unpaid'
    | 'paused'
    | 'trialing';
  hasPaidInvoice: boolean;
  paidThrough: number;
  failedRenewalAt: number | null;
  cancelAtPeriodEnd: boolean;
  verifiedAt: number;
}

export interface HostedSponsorshipState {
  organizationId: string;
  subscriptions: readonly HostedSubscriptionState[];
}

export interface HostedPolicyInput {
  now: number;
  lifecycle: 'active' | 'deleting' | 'deleted';
  previewEligible: boolean;
  revision: number;
  limits: HostedLimits;
  subscriptions: readonly HostedSubscriptionState[];
  sponsorship?: HostedSponsorshipState | null;
  billingUnavailable: boolean;
  renewalGraceDays: number;
  outageGraceHours: number;
}

export function evaluateHostedEntitlement(input: HostedPolicyInput): HostedEntitlement {
  const { now, limits } = input;
  if (
    !Number.isSafeInteger(now) ||
    now < 0 ||
    now > MAX_DATE_MS ||
    !Number.isSafeInteger(input.revision) ||
    input.revision < 0 ||
    !Number.isSafeInteger(limits.devices) ||
    limits.devices < 1 ||
    ![limits.artifactBytes, limits.historyBytes].every(
      (v) => v === null || (Number.isSafeInteger(v) && v > 0),
    ) ||
    !Number.isFinite(input.renewalGraceDays) ||
    input.renewalGraceDays < 0 ||
    input.renewalGraceDays > 7 ||
    !Number.isFinite(input.outageGraceHours) ||
    input.outageGraceHours < 0 ||
    input.outageGraceHours > 24
  ) {
    throw new Error('Invalid hosted policy input');
  }
  const base: HostedEntitlement = {
    state: 'restricted',
    source: 'none',
    planKey: null,
    fundedBy: 'none',
    organizationId: null,
    capabilities: { syncWrite: false, meshSubmit: false },
    limits: { ...limits },
    previewEndsAt: PREVIEW_ENDS_AT,
    accessUntil: null,
    graceUntil: null,
    checkedAt: new Date(now).toISOString(),
    revision: input.revision,
    reason: 'account-deleted',
  };
  if (input.lifecycle !== 'active') return base;

  return {
    ...base,
    state: 'active',
    capabilities: { syncWrite: true, meshSubmit: true },
    reason: 'free',
  };
}

export function freeHostedEntitlement(
  now: number,
  limits: HostedLimits,
  lifecycle: HostedPolicyInput['lifecycle'] = 'active',
  revision = 0,
): HostedEntitlement {
  return evaluateHostedEntitlement({
    now,
    lifecycle,
    previewEligible: false,
    revision,
    limits,
    subscriptions: [],
    billingUnavailable: false,
    renewalGraceDays: 0,
    outageGraceHours: 0,
  });
}
