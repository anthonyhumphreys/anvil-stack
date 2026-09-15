// BILL-04: website-facing device management + data/deletion routes under
// /internal/hosted/* (HMAC service channel) backed by the new
// SessionCoordinator *-for-account / delete-account-by-id internal routes.

import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type {
  DeviceSession,
  DeviceSummary,
  EnrollmentCodeIssueResult,
} from '../../contract/auth';
import { isRpcError } from '../../contract/envelope';
import type { HostedIdentity } from '../src/hosted/identity';
import { signHostedServiceRequest } from '../src/hosted/service-auth';
import { getBillingAccountByIdentity, getOrCreateBillingAccount } from '../src/hosted/store';
import { postRpc } from './helpers';

const SERVICE_KEY_ID = 'test';
const SERVICE_SECRET = 'a'.repeat(32);
const SERVICE_AUDIENCE = 'anvil-hosted';

function hostedDb(): D1Database {
  const db = env.HOSTED_DB;
  if (db === undefined) throw new Error('HOSTED_DB binding missing in test env');
  return db;
}

function makeIdentity(tag: string): HostedIdentity {
  return { workosClientId: `client_${tag}`, workosUserId: `user_${tag}` };
}

/** Signs and POSTs a service request to an /internal/hosted/* route. */
async function signedHostedPost(
  path: string,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const payload = new TextEncoder().encode(JSON.stringify(body));
  const url = `https://spike.test${path}`;
  const headers = await signHostedServiceRequest(
    new Request(url, { method: 'POST' }),
    payload,
    { audience: SERVICE_AUDIENCE, keyId: SERVICE_KEY_ID, secret: SERVICE_SECRET },
    Date.now(),
  );
  const response = await SELF.fetch(
    new Request(url, { method: 'POST', headers, body: payload }),
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function enrollWithCode(
  code: string,
  installationId: string,
): Promise<DeviceSession> {
  const response = await SELF.fetch('https://spike.test/v1/enroll', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      proof: { method: 'enrollment-code', code },
      installationId,
      displayName: 'Hosted test device',
    }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as DeviceSession;
}

/**
 * The hosted pairing flow: mints an enrollment code for the identity's
 * mapped sync account (linking it on first use), then enrolls a device.
 */
async function pairAndEnroll(
  identity: HostedIdentity,
  installationId: string,
): Promise<{ session: DeviceSession; accountId: string }> {
  const pair = await signedHostedPost('/internal/hosted/pair-device', identity);
  expect(pair.status).toBe(200);
  const session = await enrollWithCode(pair.body['code'] as string, installationId);
  return { session, accountId: pair.body['accountId'] as string };
}

function errorOf(body: Record<string, unknown>): { code: string; details?: { reason?: string } } {
  return body['error'] as { code: string; details?: { reason?: string } };
}

describe('hosted devices', () => {
  it('lists every enrolled device on the mapped account with self:false', async () => {
    const identity = makeIdentity(`dev-${crypto.randomUUID()}`);
    const first = await pairAndEnroll(identity, 'inst-web-a');
    const second = await pairAndEnroll(identity, 'inst-web-b');

    const listed = await signedHostedPost('/internal/hosted/devices', identity);
    expect(listed.status).toBe(200);
    const devices = listed.body['devices'] as DeviceSummary[];
    expect(devices).toHaveLength(2);
    const byEnrollment = new Map(devices.map((d) => [d.enrollmentId, d]));
    const expected = new Map([
      [first.session.enrollmentId, 'inst-web-a'],
      [second.session.enrollmentId, 'inst-web-b'],
    ]);
    for (const [enrollmentId, installationId] of expected) {
      const row = byEnrollment.get(enrollmentId);
      expect(row).toBeDefined();
      expect(row?.self).toBe(false);
      expect(row?.revoked).toBe(false);
      expect(row?.installationId).toBe(installationId);
      expect(row?.displayName).toBe('Hosted test device');
    }
  });

  it('renames a device by enrollmentId and persists it to the list', async () => {
    const identity = makeIdentity(`ren-${crypto.randomUUID()}`);
    const { session: keeper } = await pairAndEnroll(identity, 'inst-keep');
    const { session: renamed, accountId } = await pairAndEnroll(identity, 'inst-rename');

    const result = await signedHostedPost('/internal/hosted/device-rename', {
      ...identity,
      enrollmentId: renamed.enrollmentId,
      displayName: 'Office Mac',
    });
    expect(result.status).toBe(200);
    expect(result.body['renamed']).toBe(true);
    expect(result.body['enrollmentId']).toBe(renamed.enrollmentId);

    const listed = await signedHostedPost('/internal/hosted/devices', identity);
    const devices = listed.body['devices'] as DeviceSummary[];
    expect(devices.find((d) => d.enrollmentId === renamed.enrollmentId)?.displayName).toBe(
      'Office Mac',
    );
    expect(devices.find((d) => d.enrollmentId === keeper.enrollmentId)?.displayName).toBe(
      'Hosted test device',
    );

    // An enrollment on somebody else's account is not-found, never renamed.
    const foreign = await signedHostedPost('/internal/hosted/device-rename', {
      ...makeIdentity(`other-${crypto.randomUUID()}`),
      enrollmentId: renamed.enrollmentId,
      displayName: 'Nope',
    });
    expect(foreign.status).toBe(404);
    const stranger = await pairAndEnroll(
      makeIdentity(`stranger-${crypto.randomUUID()}`),
      'inst-stranger',
    );
    const crossAccount = await signedHostedPost('/internal/hosted/device-rename', {
      ...identity,
      enrollmentId: stranger.session.enrollmentId,
      displayName: 'Nope',
    });
    expect(crossAccount.status).toBe(404);
    expect(errorOf(crossAccount.body).code).toBe('not-found');
    expect(accountId).not.toBe(stranger.accountId);
  });

  it('rejects malformed rename and revoke bodies', async () => {
    const identity = makeIdentity(`bad-${crypto.randomUUID()}`);
    await pairAndEnroll(identity, 'inst-bad');
    const cases: [string, unknown][] = [
      ['/internal/hosted/device-rename', { ...identity, enrollmentId: '', displayName: 'x' }],
      [
        '/internal/hosted/device-rename',
        { ...identity, enrollmentId: 'enr_x', displayName: 'y'.repeat(81) },
      ],
      [
        '/internal/hosted/device-rename',
        { ...identity, enrollmentId: 'enr_x', displayName: 42 },
      ],
      ['/internal/hosted/device-revoke', { ...identity }],
      ['/internal/hosted/device-revoke', { ...identity, enrollmentId: '' }],
    ];
    for (const [path, body] of cases) {
      const response = await signedHostedPost(path, body);
      expect(response.status).toBe(400);
      expect(errorOf(response.body).code).toBe('malformed-request');
    }
  });

  it('revokes a device so its session no longer validates', async () => {
    const identity = makeIdentity(`rev-${crypto.randomUUID()}`);
    const { session: keeper } = await pairAndEnroll(identity, 'inst-keep');
    const { session: revoked } = await pairAndEnroll(identity, 'inst-revoke');

    const result = await signedHostedPost('/internal/hosted/device-revoke', {
      ...identity,
      enrollmentId: revoked.enrollmentId,
    });
    expect(result.status).toBe(200);
    expect(result.body['revoked']).toBe(true);

    // The revoked device's bearer fails session validation outright.
    const rpc = await postRpc('device.list', {}, `Bearer ${revoked.accessToken}`);
    expect(isRpcError(rpc.body)).toBe(true);
    expect((rpc.body as { error: { code: string } }).error.code).toBe('unauthenticated');

    // The list still shows the row — flagged revoked — and the sibling is
    // unaffected (its bearer still works).
    const listed = await signedHostedPost('/internal/hosted/devices', identity);
    const devices = listed.body['devices'] as DeviceSummary[];
    expect(devices.find((d) => d.enrollmentId === revoked.enrollmentId)?.revoked).toBe(true);
    expect(devices.find((d) => d.enrollmentId === keeper.enrollmentId)?.revoked).toBe(false);
    const alive = await postRpc('device.list', {}, `Bearer ${keeper.accessToken}`);
    expect(isRpcError(alive.body)).toBe(false);

    // Revocation is idempotent and account-scoped.
    const again = await signedHostedPost('/internal/hosted/device-revoke', {
      ...identity,
      enrollmentId: revoked.enrollmentId,
    });
    expect(again.status).toBe(200);
    const missing = await signedHostedPost('/internal/hosted/device-revoke', {
      ...identity,
      enrollmentId: 'enr_nonexistent',
    });
    expect(missing.status).toBe(404);
  });
});

describe('hosted data-status', () => {
  it('reports a clean state for a linked account', async () => {
    const identity = makeIdentity(`ds-${crypto.randomUUID()}`);
    const { accountId } = await pairAndEnroll(identity, 'inst-ds');
    const status = await signedHostedPost('/internal/hosted/data-status', identity);
    expect(status.status).toBe(200);
    expect(status.body['syncAccountId']).toBe(accountId);
    expect(status.body['tombstoned']).toBe(false);
    expect(status.body['deletion']).toEqual({ state: 'none' });
  });

  it('reports the null shape for an unlinked billing account', async () => {
    const identity = makeIdentity(`unlinked-${crypto.randomUUID()}`);
    await getOrCreateBillingAccount(hostedDb(), identity);
    const status = await signedHostedPost('/internal/hosted/data-status', identity);
    expect(status.status).toBe(200);
    expect(status.body).toEqual({
      syncAccountId: null,
      tombstoned: false,
      deletion: { state: 'none' },
    });
  });

  it('surfaces a device-initiated deletion on the mapped account', async () => {
    const identity = makeIdentity(`dsdel-${crypto.randomUUID()}`);
    const { session, accountId } = await pairAndEnroll(identity, 'inst-dsdel');
    const deleted = await postRpc('account.delete', {}, `Bearer ${session.accessToken}`);
    expect(isRpcError(deleted.body)).toBe(false);

    const status = await signedHostedPost('/internal/hosted/data-status', identity);
    expect(status.status).toBe(200);
    expect(status.body['syncAccountId']).toBe(accountId);
    expect(status.body['tombstoned']).toBe(true);
    const deletion = status.body['deletion'] as { state: string; purgedRows?: number };
    expect(['deleting', 'deleted']).toContain(deletion.state);
  });
});

describe('hosted delete-account', () => {
  it('tombstones the sync account, revokes sessions, marks billing deleting, and is idempotent', async () => {
    const identity = makeIdentity(`del-${crypto.randomUUID()}`);
    const { session, accountId } = await pairAndEnroll(identity, 'inst-del');

    const first = await signedHostedPost('/internal/hosted/delete-account', identity);
    expect(first.status).toBe(200);
    expect(['deleting', 'deleted']).toContain(first.body['state']);

    // Every session on the mapped account is revoked.
    const revoked = await postRpc('device.list', {}, `Bearer ${session.accessToken}`);
    expect(isRpcError(revoked.body)).toBe(true);
    expect((revoked.body as { error: { code: string } }).error.code).toBe('unauthenticated');

    // The billing row moved to 'deleting' and the request was audited.
    const billing = await getBillingAccountByIdentity(hostedDb(), identity);
    expect(billing?.lifecycle).toBe('deleting');
    const auditRow = await hostedDb()
      .prepare(
        "SELECT kind, detail FROM billing_audit WHERE billing_account_id = ? AND kind = 'account.delete-requested'",
      )
      .bind(billing?.id)
      .first<{ kind: string; detail: string }>();
    expect(auditRow).not.toBeNull();
    expect(JSON.parse(auditRow!.detail)['syncAccountId']).toBe(accountId);

    // The whole signed surface now denies on lifecycle.
    for (const path of [
      '/internal/hosted/devices',
      '/internal/hosted/pair-device',
      '/internal/hosted/data-status',
    ]) {
      const denied = await signedHostedPost(path, identity);
      expect(denied.status).toBe(403);
      expect(errorOf(denied.body).code).toBe('forbidden');
      expect(errorOf(denied.body).details?.reason).toBe('account-deleted');
    }

    // Second call is idempotent: still 200, still reporting the state.
    const second = await signedHostedPost('/internal/hosted/delete-account', identity);
    expect(second.status).toBe(200);
    expect(['deleting', 'deleted']).toContain(second.body['state']);
  });

  it('returns not-found for unknown identities and unlinked accounts', async () => {
    const unknown = makeIdentity(`ghost-${crypto.randomUUID()}`);
    for (const path of [
      '/internal/hosted/devices',
      '/internal/hosted/device-rename',
      '/internal/hosted/device-revoke',
      '/internal/hosted/data-status',
      '/internal/hosted/delete-account',
    ]) {
      const missing = await signedHostedPost(path, {
        ...unknown,
        enrollmentId: 'enr_x',
        displayName: 'x',
      });
      expect(missing.status).toBe(404);
      expect(errorOf(missing.body).code).toBe('not-found');
    }

    const unlinked = makeIdentity(`unlinked-${crypto.randomUUID()}`);
    await getOrCreateBillingAccount(hostedDb(), unlinked);
    for (const path of [
      '/internal/hosted/devices',
      '/internal/hosted/device-revoke',
      '/internal/hosted/delete-account',
    ]) {
      const response = await signedHostedPost(path, { ...unlinked, enrollmentId: 'enr_x' });
      expect(response.status).toBe(404);
      expect(errorOf(response.body).details?.reason).toBe('unlinked');
    }
  });
});
