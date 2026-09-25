import { describe, expect, it } from 'vitest';

import {
  evaluateHostedEntitlement,
  PREVIEW_END_MS,
  PREVIEW_ENDS_AT,
  type HostedPolicyInput,
  type HostedSubscriptionState,
} from '../src/hosted/policy';

const DAY = 86_400_000;
const HOUR = 3_600_000;

function input(overrides: Partial<HostedPolicyInput> = {}): HostedPolicyInput {
  return {
    now: PREVIEW_END_MS - DAY,
    lifecycle: 'active',
    previewEligible: true,
    revision: 1,
    limits: { devices: 3, artifactBytes: 1024, historyBytes: 1024 },
    subscriptions: [],
    billingUnavailable: false,
    renewalGraceDays: 7,
    outageGraceHours: 24,
    ...overrides,
  };
}

function sub(overrides: Partial<HostedSubscriptionState> = {}): HostedSubscriptionState {
  return {
    planKey: 'sync_personal',
    status: 'active',
    hasPaidInvoice: true,
    paidThrough: PREVIEW_END_MS + 30 * DAY,
    failedRenewalAt: null,
    cancelAtPeriodEnd: false,
    verifiedAt: PREVIEW_END_MS - DAY,
    ...overrides,
  };
}

describe('evaluateHostedEntitlement', () => {
  it('grants preview one millisecond before the cutoff', () => {
    const result = evaluateHostedEntitlement(input({ now: PREVIEW_END_MS - 1 }));
    expect(result.state).toBe('preview');
    expect(result.source).toBe('preview');
    expect(result.reason).toBe('preview');
    expect(result.capabilities).toEqual({ syncWrite: true, meshSubmit: true });
    expect(result.planKey).toBe('sync_personal');
    expect(result.accessUntil).toBe(PREVIEW_ENDS_AT);
    expect(result.graceUntil).toBeNull();
    expect(result.checkedAt).toBe(new Date(PREVIEW_END_MS - 1).toISOString());
    expect(result.revision).toBe(1);
    expect(result.limits).toEqual({ devices: 3, artifactBytes: 1024, historyBytes: 1024 });
  });

  it.each([0, 1])('denies at cutoff +%dms when no paid subscription exists', (delta) => {
    const result = evaluateHostedEntitlement(input({ now: PREVIEW_END_MS + delta }));
    expect(result.state).toBe('restricted');
    expect(result.source).toBe('none');
    expect(result.reason).toBe('preview-ended');
    expect(result.capabilities).toEqual({ syncWrite: false, meshSubmit: false });
    expect(result.accessUntil).toBeNull();
  });

  it('denies before cutoff when not preview eligible and unpaid', () => {
    const result = evaluateHostedEntitlement(input({ previewEligible: false }));
    expect(result.state).toBe('restricted');
    expect(result.reason).toBe('subscription-required');
  });

  it.each(['deleting', 'deleted'] as const)(
    'always denies lifecycle=%s before and after preview end',
    (lifecycle) => {
      for (const now of [PREVIEW_END_MS - 1, PREVIEW_END_MS + DAY]) {
        const result = evaluateHostedEntitlement(input({ lifecycle, now }));
        expect(result.state).toBe('restricted');
        expect(result.reason).toBe('account-deleted');
        expect(result.capabilities.syncWrite).toBe(false);
      }
    },
  );

  it('grants active paid subscription with accessUntil at paidThrough', () => {
    const paidThrough = PREVIEW_END_MS + 30 * DAY;
    const result = evaluateHostedEntitlement(input({ subscriptions: [sub({ paidThrough })] }));
    expect(result.state).toBe('active');
    expect(result.source).toBe('subscription');
    expect(result.reason).toBe('paid');
    expect(result.accessUntil).toBe(new Date(paidThrough).toISOString());
    expect(Date.parse(result.accessUntil!)).toBeGreaterThan(PREVIEW_END_MS - DAY);
  });

  it('denies active subscription without a paid invoice after preview end', () => {
    const result = evaluateHostedEntitlement(
      input({
        now: PREVIEW_END_MS + DAY,
        subscriptions: [sub({ hasPaidInvoice: false })],
      }),
    );
    expect(result.state).toBe('restricted');
    expect(result.reason).toBe('preview-ended');
  });

  it('honors cancelAtPeriodEnd paidUntil then denies even during outage', () => {
    const paidThrough = PREVIEW_END_MS + 10 * DAY;
    const subscription = sub({ cancelAtPeriodEnd: true, paidThrough });
    const active = evaluateHostedEntitlement(
      input({ subscriptions: [subscription] }),
    );
    expect(active.state).toBe('active');
    expect(active.accessUntil).toBe(new Date(paidThrough).toISOString());

    const expired = evaluateHostedEntitlement(
      input({ now: paidThrough, subscriptions: [subscription], billingUnavailable: true }),
    );
    expect(expired.state).toBe('unknown');
    expect(expired.reason).toBe('billing-unavailable');
    expect(expired.capabilities.syncWrite).toBe(false);
  });

  it('grants renewal grace from the first failed renewal for seven days', () => {
    const failedAt = PREVIEW_END_MS + 5 * DAY;
    const paidThrough = failedAt + 30 * DAY;
    const subscription = sub({
      status: 'past_due',
      paidThrough,
      failedRenewalAt: failedAt,
      verifiedAt: failedAt,
    });
    const now = failedAt + DAY;
    const result = evaluateHostedEntitlement(
      input({ now, subscriptions: [subscription], previewEligible: false }),
    );
    expect(result.state).toBe('grace');
    expect(result.source).toBe('renewal-grace');
    expect(result.reason).toBe('renewal-failed');
    expect(result.graceUntil).toBe(new Date(failedAt + 7 * DAY).toISOString());
    expect(result.accessUntil).toBe(new Date(failedAt + 7 * DAY).toISOString());
  });

  it('denies exactly at the renewal grace end and never extends on later invocations', () => {
    const failedAt = PREVIEW_END_MS + 5 * DAY;
    const subscription = sub({
      status: 'past_due',
      paidThrough: failedAt + 30 * DAY,
      failedRenewalAt: failedAt,
      verifiedAt: failedAt,
    });
    const graceEnd = failedAt + 7 * DAY;
    const atEnd = evaluateHostedEntitlement(
      input({ now: graceEnd, subscriptions: [subscription], previewEligible: false }),
    );
    expect(atEnd.state).toBe('restricted');
    const later = evaluateHostedEntitlement(
      input({ now: graceEnd + DAY, subscriptions: [subscription], previewEligible: false }),
    );
    expect(later.state).toBe('restricted');
    expect(later.accessUntil).toBeNull();
  });

  it.each([
    'incomplete',
    'incomplete_expired',
    'canceled',
    'unpaid',
    'paused',
    'trialing',
  ] as const)('status %s never grants paid access', (status) => {
    const result = evaluateHostedEntitlement(
      input({
        now: PREVIEW_END_MS + DAY,
        previewEligible: false,
        subscriptions: [sub({ status })],
      }),
    );
    expect(result.state).toBe('restricted');
    expect(result.capabilities.syncWrite).toBe(false);
  });

  it('grants bounded outage grace for expired paid subscription during billing outage', () => {
    const paidThrough = PREVIEW_END_MS - DAY;
    const subscription = sub({ paidThrough });
    const now = paidThrough + 12 * HOUR;
    const result = evaluateHostedEntitlement(
      input({ now, subscriptions: [subscription], billingUnavailable: true, previewEligible: false }),
    );
    expect(result.state).toBe('grace');
    expect(result.source).toBe('outage-grace');
    expect(result.reason).toBe('billing-outage');
    expect(result.graceUntil).toBe(new Date(paidThrough + 24 * HOUR).toISOString());
    expect(Date.parse(result.graceUntil!) - paidThrough).toBeLessThanOrEqual(24 * HOUR);
  });

  it('denies at the exact outage bound and denies outage without verified paid history', () => {
    const paidThrough = PREVIEW_END_MS - DAY;
    const subscription = sub({ paidThrough });
    const atBound = evaluateHostedEntitlement(
      input({
        now: paidThrough + 24 * HOUR,
        subscriptions: [subscription],
        billingUnavailable: true,
        previewEligible: false,
      }),
    );
    expect(atBound.state).toBe('unknown');
    expect(atBound.reason).toBe('billing-unavailable');
    expect(atBound.capabilities.syncWrite).toBe(false);

    const noPaid = evaluateHostedEntitlement(
      input({ now: PREVIEW_END_MS + DAY, billingUnavailable: true }),
    );
    expect(noPaid.state).toBe('unknown');
    expect(noPaid.reason).toBe('billing-unavailable');
    expect(noPaid.accessUntil).toBeNull();
  });

  it('ignores future verifiedAt and non-finite boundary fields', () => {
    const now = PREVIEW_END_MS + DAY;
    for (const overrides of [
      { verifiedAt: now + DAY },
      { verifiedAt: Number.NaN },
      { paidThrough: Number.NaN },
      { paidThrough: Number.POSITIVE_INFINITY },
      { failedRenewalAt: Number.NaN, status: 'past_due' as const },
    ]) {
      const result = evaluateHostedEntitlement(
        input({
          now,
          previewEligible: false,
          subscriptions: [sub(overrides)],
        }),
      );
      expect(result.state).toBe('restricted');
      expect(result.capabilities.syncWrite).toBe(false);
    }
  });

  it('ignores a foreign plan key injected via cast', () => {
    const foreign = sub({ planKey: 'other_product' as 'sync_personal' });
    const result = evaluateHostedEntitlement(
      input({
        now: PREVIEW_END_MS + DAY,
        previewEligible: false,
        subscriptions: [foreign],
      }),
    );
    expect(result.state).toBe('restricted');
    expect(result.planKey).toBeNull();
  });

  it('picks the maximum paidThrough across valid subscriptions', () => {
    const later = PREVIEW_END_MS + 60 * DAY;
    const result = evaluateHostedEntitlement(
      input({
        subscriptions: [
          sub({ paidThrough: PREVIEW_END_MS + 10 * DAY }),
          sub({ paidThrough: later }),
        ],
      }),
    );
    expect(result.accessUntil).toBe(new Date(later).toISOString());
  });

  it('grants no extension with renewalGraceDays 0', () => {
    const failedAt = PREVIEW_END_MS + 5 * DAY;
    const subscription = sub({
      status: 'past_due',
      paidThrough: failedAt + 30 * DAY,
      failedRenewalAt: failedAt,
      verifiedAt: failedAt,
    });
    const result = evaluateHostedEntitlement(
      input({
        now: failedAt + HOUR,
        subscriptions: [subscription],
        previewEligible: false,
        renewalGraceDays: 0,
      }),
    );
    expect(result.state).toBe('restricted');
  });

  it('does not mutate its input', () => {
    const subscriptions = [sub({ status: 'past_due', failedRenewalAt: PREVIEW_END_MS })];
    const fixture = input({ subscriptions });
    const snapshot = JSON.parse(JSON.stringify(fixture));
    evaluateHostedEntitlement(fixture);
    expect(fixture).toEqual(snapshot);
  });

  it.each([
    { now: -1 },
    { now: Number.NaN },
    { now: 8_640_000_000_000_001 },
    { revision: -1 },
    { limits: { devices: 0, artifactBytes: 1024, historyBytes: 1024 } },
    { limits: { devices: 3, artifactBytes: 1.5, historyBytes: 1024 } },
    { renewalGraceDays: 8 },
    { outageGraceHours: 25 },
  ])('rejects invalid input %o', (overrides) => {
    expect(() => evaluateHostedEntitlement(input(overrides))).toThrow('Invalid hosted policy input');
  });
});
