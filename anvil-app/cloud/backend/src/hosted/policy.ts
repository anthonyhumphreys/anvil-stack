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
  betaAccessUntil?: number | null;
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
    reason: input.lifecycle === 'active' ? 'subscription-required' : 'account-deleted',
  };
  if (input.lifecycle !== 'active') return base;

  const candidates = [
    ...input.subscriptions.map((subscription) => ({ subscription, organizationId: null })),
    ...(input.sponsorship?.subscriptions ?? []).map((subscription) => ({
      subscription,
      organizationId: input.sponsorship!.organizationId,
    })),
  ].filter(
    ({ subscription }) =>
      subscription.hasPaidInvoice &&
      [subscription.paidThrough, subscription.verifiedAt].every(
        (value) => Number.isSafeInteger(value) && value > 0 && value <= MAX_DATE_MS,
      ) &&
      subscription.verifiedAt <= now &&
      ['active', 'past_due', 'canceled'].includes(subscription.status),
  );
  const paid = candidates
    .filter(({ subscription }) => subscription.paidThrough > now)
    .sort((left, right) => right.subscription.paidThrough - left.subscription.paidThrough)[0];
  const grant = (candidate: (typeof candidates)[number], until: number): HostedEntitlement => ({
    ...base,
    state: 'active',
    source: 'subscription',
    planKey: candidate.subscription.planKey,
    fundedBy: candidate.organizationId === null ? 'personal' : 'team',
    organizationId: candidate.organizationId,
    capabilities: { syncWrite: true, meshSubmit: true },
    accessUntil: new Date(until).toISOString(),
    reason: 'paid',
  });
  if (paid !== undefined) return grant(paid, paid.subscription.paidThrough);

  const betaUntil = input.betaAccessUntil;
  if (
    typeof betaUntil === 'number' &&
    Number.isSafeInteger(betaUntil) &&
    betaUntil > now &&
    betaUntil <= MAX_DATE_MS
  ) {
    return {
      ...base,
      state: 'preview',
      source: 'preview',
      fundedBy: 'preview',
      capabilities: { syncWrite: true, meshSubmit: true },
      previewEndsAt: new Date(betaUntil).toISOString(),
      accessUntil: new Date(betaUntil).toISOString(),
      reason: 'preview',
    };
  }

  for (const candidate of candidates) {
    const { subscription } = candidate;
    const failedAt = subscription.failedRenewalAt;
    const renewalUntil = Math.min(
      subscription.paidThrough + input.renewalGraceDays * 86_400_000,
      (failedAt ?? 0) + input.renewalGraceDays * 86_400_000,
    );
    if (
      subscription.status === 'past_due' &&
      typeof failedAt === 'number' &&
      Number.isSafeInteger(failedAt) &&
      failedAt > 0 &&
      failedAt <= now &&
      renewalUntil > now
    ) {
      return {
        ...grant(candidate, subscription.paidThrough),
        state: 'grace',
        source: 'renewal-grace',
        reason: 'renewal-failed',
        graceUntil: new Date(renewalUntil).toISOString(),
      };
    }
    const outageUntil =
      Math.min(subscription.paidThrough, subscription.verifiedAt) +
      input.outageGraceHours * 3_600_000;
    if (input.billingUnavailable && subscription.status === 'active' && outageUntil > now) {
      return {
        ...grant(candidate, subscription.paidThrough),
        state: 'grace',
        source: 'outage-grace',
        reason: 'billing-outage',
        graceUntil: new Date(outageUntil).toISOString(),
      };
    }
  }
  return input.billingUnavailable
    ? { ...base, state: 'unknown', reason: 'billing-unavailable' }
    : base;
}

export function freeHostedEntitlement(
  now: number,
  limits: HostedLimits,
  lifecycle: HostedPolicyInput['lifecycle'] = 'active',
  revision = 0,
): HostedEntitlement {
  const entitlement = evaluateHostedEntitlement({
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
  return lifecycle === 'active'
    ? {
        ...entitlement,
        state: 'active',
        capabilities: { syncWrite: true, meshSubmit: true },
        reason: 'free',
      }
    : entitlement;
}
