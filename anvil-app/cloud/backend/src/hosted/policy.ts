import type { HostedEntitlement, HostedLimits } from '../../../contract/entitlements';

export const PREVIEW_ENDS_AT = '2026-11-01T00:00:00.000Z';
export const PREVIEW_END_MS = Date.parse(PREVIEW_ENDS_AT);
const DAY = 86_400_000;
const MAX_DATE_MS = 8_640_000_000_000_000;

/** Provisional hosted quotas — test fixtures, not advertised product limits. */
export const DEFAULT_HOSTED_LIMITS: HostedLimits = {
  devices: 10,
  artifactBytes: 5 * 1024 * 1024 * 1024,
  historyBytes: 1024 * 1024 * 1024,
};

export interface HostedSubscriptionState {
  planKey: 'sync_personal';
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

export interface HostedPolicyInput {
  now: number;
  lifecycle: 'active' | 'deleting' | 'deleted';
  previewEligible: boolean;
  revision: number;
  limits: HostedLimits;
  subscriptions: readonly HostedSubscriptionState[];
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
    !Object.values(limits).every((v) => Number.isSafeInteger(v) && v > 0) ||
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
  ): HostedEntitlement => {
    const capped = Math.min(end, MAX_DATE_MS);
    return {
      ...base,
      state,
      source,
      reason,
      planKey: 'sync_personal',
      capabilities: { syncWrite: true, meshSubmit: true },
      accessUntil: new Date(capped).toISOString(),
      graceUntil: state === 'grace' ? new Date(capped).toISOString() : null,
    };
  };
  const paid = input.subscriptions.filter(
    (s) =>
      s.planKey === 'sync_personal' &&
      s.hasPaidInvoice &&
      Number.isSafeInteger(s.verifiedAt) &&
      s.verifiedAt >= 0 &&
      s.verifiedAt <= now &&
      Number.isSafeInteger(s.paidThrough) &&
      s.paidThrough > 0 &&
      s.paidThrough <= MAX_DATE_MS,
  );
  const paidUntil = Math.max(
    0,
    ...paid.filter((s) => s.status === 'active').map((s) => s.paidThrough),
  );
  if (paidUntil > now) return grant('active', 'subscription', 'paid', paidUntil);
  if (input.previewEligible && now < PREVIEW_END_MS)
    return grant('preview', 'preview', 'preview', PREVIEW_END_MS);
  const renewalUntil = Math.max(
    0,
    ...paid
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
  if (renewalUntil > now) return grant('grace', 'renewal-grace', 'renewal-failed', renewalUntil);
  const outageUntil = input.billingUnavailable
    ? Math.max(
        0,
        ...paid
          .filter((s) => s.status === 'active' && !s.cancelAtPeriodEnd)
          .map((s) => s.paidThrough + input.outageGraceHours * 3_600_000),
      )
    : 0;
  if (outageUntil > now) return grant('grace', 'outage-grace', 'billing-outage', outageUntil);
  return input.billingUnavailable
    ? { ...base, state: 'unknown', reason: 'billing-unavailable' }
    : base;
}
