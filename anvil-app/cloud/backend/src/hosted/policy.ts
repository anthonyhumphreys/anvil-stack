import type { HostedEntitlement, HostedLimits } from '../../../contract/entitlements';

export const PREVIEW_ENDS_AT = '2026-11-01T00:00:00.000Z';
export const PREVIEW_END_MS = Date.parse(PREVIEW_ENDS_AT);
const DAY = 86_400_000;
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
    reason: now >= PREVIEW_END_MS ? 'preview-ended' : 'subscription-required',
  };
  if (input.lifecycle !== 'active') return { ...base, reason: 'account-deleted' };
  const grant = (
    state: HostedEntitlement['state'],
    source: HostedEntitlement['source'],
    reason: HostedEntitlement['reason'],
    end: number,
    planKey: HostedEntitlement['planKey'],
    fundedBy: HostedEntitlement['fundedBy'],
    organizationId: string | null = null,
  ): HostedEntitlement => {
    const capped = Math.min(end, MAX_DATE_MS);
    return {
      ...base,
      state,
      source,
      reason,
      planKey,
      fundedBy,
      organizationId,
      capabilities: { syncWrite: true, meshSubmit: true },
      accessUntil: new Date(capped).toISOString(),
      graceUntil: state === 'grace' ? new Date(capped).toISOString() : null,
    };
  };
  const validPaid = (
    subscriptions: readonly HostedSubscriptionState[],
    planKey: 'sync_personal' | 'sync_team',
  ) =>
    subscriptions.filter(
      (s) =>
        s.planKey === planKey &&
        s.hasPaidInvoice &&
        Number.isSafeInteger(s.verifiedAt) &&
        s.verifiedAt >= 0 &&
        s.verifiedAt <= now &&
        Number.isSafeInteger(s.paidThrough) &&
        s.paidThrough > 0 &&
        s.paidThrough <= MAX_DATE_MS,
    );
  const personalPaid = validPaid(input.subscriptions, 'sync_personal');
  const teamPaid =
    input.sponsorship !== undefined &&
    input.sponsorship !== null &&
    typeof input.sponsorship.organizationId === 'string' &&
    input.sponsorship.organizationId.length > 0
      ? validPaid(input.sponsorship.subscriptions, 'sync_team')
      : [];
  const paidUntil = Math.max(
    0,
    ...personalPaid.filter((s) => s.status === 'active').map((s) => s.paidThrough),
  );
  const teamPaidUntil = Math.max(
    0,
    ...teamPaid.filter((s) => s.status === 'active').map((s) => s.paidThrough),
  );
  if (teamPaidUntil > now) {
    return grant(
      'active',
      'subscription',
      'paid',
      teamPaidUntil,
      'sync_team',
      'team',
      input.sponsorship?.organizationId ?? null,
    );
  }
  if (paidUntil > now)
    return grant('active', 'subscription', 'paid', paidUntil, 'sync_personal', 'personal');
  if (input.previewEligible && now < PREVIEW_END_MS)
    return grant('preview', 'preview', 'preview', PREVIEW_END_MS, null, 'preview');
  const teamRenewalUntil = Math.max(
    0,
    ...teamPaid
      .filter(
        (s) =>
          s.status === 'past_due' &&
          s.failedRenewalAt !== null &&
          Number.isSafeInteger(s.failedRenewalAt) &&
          s.failedRenewalAt > 0 &&
          s.failedRenewalAt <= now &&
          s.failedRenewalAt <= s.verifiedAt &&
          s.failedRenewalAt <= s.paidThrough &&
          !s.cancelAtPeriodEnd,
      )
      .map((s) =>
        Math.min(
          s.failedRenewalAt! + input.renewalGraceDays * DAY,
          s.paidThrough + input.renewalGraceDays * DAY,
        ),
      ),
  );
  if (teamRenewalUntil > now) {
    return grant(
      'grace',
      'renewal-grace',
      'renewal-failed',
      teamRenewalUntil,
      'sync_team',
      'team',
      input.sponsorship?.organizationId ?? null,
    );
  }
  const renewalUntil = Math.max(
    0,
    ...personalPaid
      .filter(
        (s) =>
          s.status === 'past_due' &&
          s.failedRenewalAt !== null &&
          Number.isSafeInteger(s.failedRenewalAt) &&
          s.failedRenewalAt > 0 &&
          s.failedRenewalAt <= now &&
          s.failedRenewalAt <= s.verifiedAt &&
          s.failedRenewalAt <= s.paidThrough &&
          !s.cancelAtPeriodEnd,
      )
      .map((s) =>
        Math.min(
          s.failedRenewalAt! + input.renewalGraceDays * DAY,
          s.paidThrough + input.renewalGraceDays * DAY,
        ),
      ),
  );
  if (renewalUntil > now)
    return grant(
      'grace',
      'renewal-grace',
      'renewal-failed',
      renewalUntil,
      'sync_personal',
      'personal',
    );
  const outageUntil = input.billingUnavailable
    ? Math.max(
        0,
        ...personalPaid
          .filter((s) => s.status === 'active' && !s.cancelAtPeriodEnd)
          .map((s) => s.paidThrough + input.outageGraceHours * 3_600_000),
      )
    : 0;
  if (outageUntil > now)
    return grant(
      'grace',
      'outage-grace',
      'billing-outage',
      outageUntil,
      'sync_personal',
      'personal',
    );
  return input.billingUnavailable
    ? { ...base, state: 'unknown', reason: 'billing-unavailable' }
    : base;
}
