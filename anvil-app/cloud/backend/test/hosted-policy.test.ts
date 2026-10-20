import { describe, expect, it } from 'vitest';
import {
  evaluateHostedEntitlement,
  PREVIEW_END_MS,
  type HostedPolicyInput,
  type HostedSubscriptionState,
} from '../src/hosted/policy';

const DAY = 86_400_000;
const NOW = PREVIEW_END_MS + 30 * DAY;
function input(overrides: Partial<HostedPolicyInput> = {}): HostedPolicyInput {
  return {
    now: NOW,
    lifecycle: 'active',
    previewEligible: true,
    revision: 1,
    limits: { devices: 5, artifactBytes: null, historyBytes: null },
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
    paidThrough: NOW + DAY,
    failedRenewalAt: null,
    cancelAtPeriodEnd: false,
    verifiedAt: NOW - DAY,
    ...overrides,
  };
}

describe('hosted entitlement policy', () => {
  it.each([PREVIEW_END_MS - 1, PREVIEW_END_MS, NOW])(
    'never grants a blanket preview at %s',
    (now) => {
      expect(evaluateHostedEntitlement(input({ now }))).toMatchObject({
        state: 'restricted',
        reason: 'subscription-required',
        capabilities: { syncWrite: false, meshSubmit: false },
      });
    },
  );
  it('grants paid access through the paid period, including scheduled cancellation', () => {
    expect(
      evaluateHostedEntitlement(input({ subscriptions: [sub({ cancelAtPeriodEnd: true })] })),
    ).toMatchObject({
      state: 'active',
      source: 'subscription',
      fundedBy: 'personal',
      reason: 'paid',
      accessUntil: new Date(NOW + DAY).toISOString(),
    });
  });
  it.each(['incomplete', 'incomplete_expired', 'unpaid', 'paused', 'trialing'] as const)(
    'does not grant access for %s',
    (status) => {
      expect(evaluateHostedEntitlement(input({ subscriptions: [sub({ status })] })).state).toBe(
        'restricted',
      );
    },
  );
  it('requires a confirmed invoice even for an active subscription', () => {
    expect(
      evaluateHostedEntitlement(input({ subscriptions: [sub({ hasPaidInvoice: false })] })).state,
    ).toBe('restricted');
  });
  it('grants beta access only until the redeemed code expires', () => {
    expect(evaluateHostedEntitlement(input({ betaAccessUntil: NOW + 1 }))).toMatchObject({
      state: 'preview',
      source: 'preview',
      reason: 'preview',
      accessUntil: new Date(NOW + 1).toISOString(),
    });
    expect(evaluateHostedEntitlement(input({ betaAccessUntil: NOW })).state).toBe('restricted');
  });
  it('bounds renewal grace by both the paid period and first failed renewal', () => {
    const subscription = sub({
      status: 'past_due',
      paidThrough: NOW - DAY,
      failedRenewalAt: NOW - DAY,
    });
    expect(evaluateHostedEntitlement(input({ subscriptions: [subscription] }))).toMatchObject({
      state: 'grace',
      source: 'renewal-grace',
      graceUntil: new Date(NOW + 6 * DAY).toISOString(),
    });
    expect(
      evaluateHostedEntitlement(input({ now: NOW + 6 * DAY, subscriptions: [subscription] })).state,
    ).toBe('restricted');
    expect(
      evaluateHostedEntitlement(
        input({ subscriptions: [sub({ ...subscription, failedRenewalAt: NOW - 8 * DAY })] }),
      ).state,
    ).toBe('restricted');
  });
  it('does not revive stale paid records during an outage', () => {
    expect(
      evaluateHostedEntitlement(
        input({ billingUnavailable: true, subscriptions: [sub({ paidThrough: NOW - DAY })] }),
      ),
    ).toMatchObject({ state: 'unknown', reason: 'billing-unavailable' });
    expect(
      evaluateHostedEntitlement(
        input({
          billingUnavailable: true,
          subscriptions: [sub({ paidThrough: NOW - 1, verifiedAt: NOW - 1 })],
        }),
      ),
    ).toMatchObject({ state: 'grace', source: 'outage-grace' });
  });
  it('uses a paid team seat when no personal subscription exists', () => {
    expect(
      evaluateHostedEntitlement(
        input({
          sponsorship: { organizationId: 'org-1', subscriptions: [sub({ planKey: 'sync_team' })] },
        }),
      ),
    ).toMatchObject({
      state: 'active',
      fundedBy: 'team',
      organizationId: 'org-1',
      planKey: 'sync_team',
    });
  });
  it.each(['deleting', 'deleted'] as const)('never grants access to a %s account', (lifecycle) => {
    expect(
      evaluateHostedEntitlement(
        input({ lifecycle, betaAccessUntil: NOW + DAY, subscriptions: [sub()] }),
      ),
    ).toMatchObject({ state: 'restricted', reason: 'account-deleted' });
  });
  it('fails closed on invalid subscription timestamps and rejects invalid policy input', () => {
    expect(
      evaluateHostedEntitlement(input({ subscriptions: [sub({ paidThrough: Number.NaN })] })).state,
    ).toBe('restricted');
    expect(() => evaluateHostedEntitlement(input({ now: Number.NaN }))).toThrow(
      'Invalid hosted policy input',
    );
    expect(() => evaluateHostedEntitlement(input({ revision: -1 }))).toThrow(
      'Invalid hosted policy input',
    );
    expect(() =>
      evaluateHostedEntitlement(
        input({ limits: { devices: 0, artifactBytes: null, historyBytes: null } }),
      ),
    ).toThrow('Invalid hosted policy input');
  });
});
