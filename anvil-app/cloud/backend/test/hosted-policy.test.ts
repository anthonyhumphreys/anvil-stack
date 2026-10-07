import { describe, expect, it } from 'vitest';

import {
  evaluateHostedEntitlement,
  PREVIEW_END_MS,
  PREVIEW_ENDS_AT,
  type HostedPolicyInput,
  type HostedSubscriptionState,
} from '../src/hosted/policy';

const DAY = 86_400_000;

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
  it.each([PREVIEW_END_MS - 1, PREVIEW_END_MS, PREVIEW_END_MS + 365 * DAY])(
    'grants the free Sync/Mesh capabilities at %s regardless of the preview deadline',
    (now) => {
      const result = evaluateHostedEntitlement(input({ now, previewEligible: false }));
      expect(result).toMatchObject({
        state: 'active',
        source: 'none',
        planKey: null,
        fundedBy: 'none',
        organizationId: null,
        capabilities: { syncWrite: true, meshSubmit: true },
        accessUntil: null,
        graceUntil: null,
        reason: 'free',
      });
      expect(result.previewEndsAt).toBe(PREVIEW_ENDS_AT);
      expect(result.checkedAt).toBe(new Date(now).toISOString());
      expect(result.limits).toEqual({ devices: 3, artifactBytes: 1024, historyBytes: 1024 });
    },
  );

  it.each([
    'active',
    'past_due',
    'incomplete',
    'incomplete_expired',
    'canceled',
    'unpaid',
    'paused',
    'trialing',
  ] as const)('does not let a legacy %s Sync subscription alter free capabilities', (status) => {
    const result = evaluateHostedEntitlement(
      input({
        now: PREVIEW_END_MS + DAY,
        subscriptions: [sub({ status })],
        billingUnavailable: true,
      }),
    );
    expect(result.state).toBe('active');
    expect(result.reason).toBe('free');
    expect(result.capabilities).toEqual({ syncWrite: true, meshSubmit: true });
    expect(result.accessUntil).toBeNull();
  });

  it.each(['deleting', 'deleted'] as const)(
    'denies capabilities when account lifecycle is %s',
    (lifecycle) => {
      const result = evaluateHostedEntitlement(
        input({ now: PREVIEW_END_MS + DAY, lifecycle }),
      );
      expect(result.state).toBe('restricted');
      expect(result.reason).toBe('account-deleted');
      expect(result.capabilities).toEqual({ syncWrite: false, meshSubmit: false });
      expect(result.accessUntil).toBeNull();
    },
  );

  it('rejects malformed time, revision, and quota input', () => {
    expect(() => evaluateHostedEntitlement(input({ now: Number.NaN }))).toThrow(
      'Invalid hosted policy input',
    );
    expect(() => evaluateHostedEntitlement(input({ revision: -1 }))).toThrow(
      'Invalid hosted policy input',
    );
    expect(() =>
      evaluateHostedEntitlement(input({ limits: { devices: 0, artifactBytes: null, historyBytes: null } })),
    ).toThrow('Invalid hosted policy input');
  });
});
