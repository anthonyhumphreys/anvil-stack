import { describe, expect, it } from 'vitest';

import {
  hostedIdentityFromOidcSubject,
  initialHostedSyncAccountId,
  requireHostedIdentityBinding,
  validateHostedIdentity,
  type HostedIdentity,
  type HostedIdentityBinding,
} from '../src/hosted/identity';

const identity: HostedIdentity = {
  workosClientId: 'client_test123',
  workosUserId: 'user_abc456',
};

function binding(overrides: Partial<HostedIdentityBinding> = {}): HostedIdentityBinding {
  return {
    ...identity,
    billingAccountId: 'acct_billing_1',
    syncAccountId: 'oidc_existing_sync',
    generation: 2,
    lifecycle: 'active',
    ...overrides,
  };
}

describe('validateHostedIdentity', () => {
  it('maps a verified OIDC subject to the website identity tuple', () => {
    expect(hostedIdentityFromOidcSubject(identity.workosClientId, identity.workosUserId)).toEqual(
      identity,
    );
    expect(hostedIdentityFromOidcSubject(identity.workosClientId, 'sub_not_workos_user')).toBeNull();
  });

  it('accepts well-formed identities', () => {
    expect(validateHostedIdentity(identity)).toBe(true);
  });

  it.each([
    null,
    undefined,
    'client_test123',
    { workosClientId: 'client_test123' },
    { workosClientId: 'noclientprefix', workosUserId: 'user_abc456' },
    { workosClientId: 'client_test123', workosUserId: 'nouserprefix' },
    { workosClientId: `client_${'a'.repeat(241)}`, workosUserId: 'user_abc456' },
    { workosClientId: 'client_test123', workosUserId: 42 },
    { workosClientId: 'client_ white space', workosUserId: 'user_abc456' },
  ])('rejects %o', (value) => {
    expect(validateHostedIdentity(value)).toBe(false);
  });
});

describe('initialHostedSyncAccountId', () => {
  it('is deterministic for the same identity', async () => {
    expect(await initialHostedSyncAccountId(identity)).toBe(
      await initialHostedSyncAccountId({ ...identity }),
    );
  });

  it('derives different IDs for a different user or client', async () => {
    const base = await initialHostedSyncAccountId(identity);
    expect(await initialHostedSyncAccountId({ ...identity, workosUserId: 'user_other' })).not.toBe(base);
    expect(
      await initialHostedSyncAccountId({ ...identity, workosClientId: 'client_other' }),
    ).not.toBe(base);
  });

  it('disambiguates concatenations via the JSON array encoding', async () => {
    const a = await initialHostedSyncAccountId({
      workosClientId: 'client_ab',
      workosUserId: 'user_c',
    });
    const b = await initialHostedSyncAccountId({
      workosClientId: 'client_abc',
      workosUserId: 'user_d',
    });
    const c = await initialHostedSyncAccountId({
      workosClientId: 'client_abcd',
      workosUserId: 'user_e',
    });
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it('prefixes derived IDs with workos_', async () => {
    expect(await initialHostedSyncAccountId(identity)).toMatch(/^workos_[a-f0-9]{64}$/);
  });

  it('rejects invalid identities', async () => {
    await expect(
      initialHostedSyncAccountId({ workosClientId: 'bad', workosUserId: 'user_abc456' }),
    ).rejects.toThrow('Invalid hosted identity');
  });
});

describe('requireHostedIdentityBinding', () => {
  it('returns an active binding honoring an existing syncAccountId and generation', () => {
    const existing = binding();
    const result = requireHostedIdentityBinding(identity, existing);
    expect(result).toBe(existing);
    expect(result.syncAccountId).toBe('oidc_existing_sync');
    expect(result.generation).toBe(2);
  });

  it.each([
    { workosUserId: 'user_other' },
    { workosClientId: 'client_other' },
  ])('rejects mismatched identity %o', (patch) => {
    expect(() => requireHostedIdentityBinding({ ...identity, ...patch }, binding())).toThrow(
      'Hosted identity mismatch',
    );
  });

  it.each(['deleting', 'deleted'] as const)('rejects lifecycle=%s', (lifecycle) => {
    expect(() => requireHostedIdentityBinding(identity, binding({ lifecycle }))).toThrow(
      'Hosted account is unavailable',
    );
  });

  it.each([
    { generation: 0 },
    { generation: 1.5 },
    { syncAccountId: '' },
    { billingAccountId: '' },
  ])('rejects invalid binding %o', (patch) => {
    expect(() => requireHostedIdentityBinding(identity, binding(patch))).toThrow(
      'Invalid hosted account binding',
    );
  });
});
