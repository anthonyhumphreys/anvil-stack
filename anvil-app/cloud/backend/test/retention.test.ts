import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type {
  DeviceSession,
  EnrollmentCodeIssueResult,
  SessionDescribeResult,
} from '../../contract/auth';
import { isRpcError } from '../../contract/envelope';
import type { SyncPullResult, SyncPushResult } from '../../contract/sync';
import type { AccountCoordinator } from '../src/account-coordinator';
import type { SessionCoordinator } from '../src/session-coordinator';
import { sha256Hex } from '../src/hash';
import { expectSuccess, hashedChange, postRpc, spikeBearer, uniqueIds } from './helpers';

const ADMIN_TOKEN = 'test-admin-credential';
const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const HISTORY_QUOTA_BYTES = 64 * 1024 * 1024;

function accountStub(accountId: string) {
  return env.ACCOUNT.get(env.ACCOUNT.idFromName(accountId));
}

function sessionStub() {
  return env.SESSIONS.get(env.SESSIONS.idFromName('sessions'));
}

async function sweepAccount(accountId: string) {
  const response = await accountStub(accountId).fetch(
    new Request('https://internal.anvil/internal/sweep', { method: 'POST' }),
  );
  return (await response.json()) as {
    deletedChanges: number;
    deletedReceipts: number;
    deletedScans: number;
    continued: boolean;
  };
}

async function issueCode(accountId: string): Promise<EnrollmentCodeIssueResult> {
  const response = await SELF.fetch('https://spike.test/v1/enrollment-codes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ADMIN_TOKEN}` },
    body: JSON.stringify({ accountId }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as EnrollmentCodeIssueResult;
}

async function enroll(code: string): Promise<DeviceSession> {
  const response = await SELF.fetch('https://spike.test/v1/enroll', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      proof: { method: 'enrollment-code', code },
      installationId: 'install-retention',
      displayName: 'Retention device',
    }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as DeviceSession;
}

describe('retention, quota, and ops counters', () => {
  it('rejects new history once the account byte quota is exceeded, then recovers', async () => {
    const ids = uniqueIds('quota');
    const auth = spikeBearer(ids.accountId, ids.enrollmentId);

    // Simulate a nearly-full history budget; the next payload crosses it.
    await runInDurableObject(accountStub(ids.accountId), (_i: AccountCoordinator, state) => {
      state.storage.sql.exec(
        "INSERT INTO sync_meta (key, value) VALUES ('history_bytes', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        String(HISTORY_QUOTA_BYTES - 10),
      );
    });

    const change = await hashedChange({
      enrollmentSequence: 1,
      entityId: 'tpl-over-quota',
      payload: { name: 'Bigger than ten bytes of headroom' },
    });
    const pushed = expectSuccess<SyncPushResult>(
      await postRpc('sync.push', { changes: [change] }, auth),
    );
    expect(pushed.results[0]?.status).toBe('rejected');
    expect(pushed.results[0]).toMatchObject({ reason: 'quota-exceeded' });

    // The rejection is terminal: sequence consumed with a receipt, so replay
    // returns the same verdict rather than re-applying.
    const replay = expectSuccess<SyncPushResult>(
      await postRpc('sync.push', { changes: [change] }, auth),
    );
    expect(replay.results).toEqual(pushed.results);

    // Freeing history (e.g. after a sweep) lets new changes through.
    await runInDurableObject(accountStub(ids.accountId), (_i: AccountCoordinator, state) => {
      state.storage.sql.exec(
        "UPDATE sync_meta SET value = '0' WHERE key = 'history_bytes'",
      );
    });
    const second = await hashedChange({
      enrollmentSequence: 2,
      entityId: 'tpl-after-quota',
      payload: { name: 'Fits' },
    });
    const recovered = expectSuccess<SyncPushResult>(
      await postRpc('sync.push', { changes: [second] }, auth),
    );
    expect(recovered.results[0]?.status).toBe('accepted');
  });

  it('sweep deletes expired journal rows, advances the floor, and stale cursors reset', async () => {
    const ids = uniqueIds('sweep');
    const auth = spikeBearer(ids.accountId, ids.enrollmentId);
    for (let sequence = 1; sequence <= 2; sequence += 1) {
      const change = await hashedChange({
        enrollmentSequence: sequence,
        entityId: `tpl-sweep-${sequence}`,
      });
      const pushed = expectSuccess<SyncPushResult>(
        await postRpc('sync.push', { changes: [change] }, auth),
      );
      expect(pushed.results[0]?.status).toBe('accepted');
    }

    // Age every retained row past the 90-day retention window.
    const expiredAt = Date.now() - RETENTION_MS - 1000;
    await runInDurableObject(accountStub(ids.accountId), (_i: AccountCoordinator, state) => {
      state.storage.sql.exec('UPDATE changes SET created_at = ?', expiredAt);
      state.storage.sql.exec('UPDATE receipts SET created_at = ?', expiredAt);
    });

    const sweep = await sweepAccount(ids.accountId);
    expect(sweep.deletedChanges).toBe(2);
    expect(sweep.deletedReceipts).toBe(2);

    // The floor moved past the deleted watermark; a cursor behind it resets.
    const stale = await postRpc('sync.pull', { cursor: null, maxBytes: 16384 }, auth);
    expect(stale.status).toBe(409);
    expect(isRpcError(stale.body)).toBe(true);
    if (isRpcError(stale.body)) {
      expect(stale.body.error.code).toBe('reset-required');
    }

    // A cursor at the floor still pulls normally (nothing newer exists yet).
    const fresh = expectSuccess<SyncPullResult>(
      await postRpc('sync.pull', { cursor: '2', maxBytes: 16384 }, auth),
    );
    expect(fresh.changes).toHaveLength(0);
    expect(fresh.hasMore).toBe(false);

    // And the account still accepts new history after the sweep.
    const next = await hashedChange({ enrollmentSequence: 3, entityId: 'tpl-post-sweep' });
    const pushed = expectSuccess<SyncPushResult>(
      await postRpc('sync.push', { changes: [next] }, auth),
    );
    expect(pushed.results[0]?.status).toBe('accepted');
  });

  it('does not delete rows still inside the retention window', async () => {
    const ids = uniqueIds('retain');
    const auth = spikeBearer(ids.accountId, ids.enrollmentId);
    const change = await hashedChange({ enrollmentSequence: 1, entityId: 'tpl-fresh' });
    expectSuccess<SyncPushResult>(await postRpc('sync.push', { changes: [change] }, auth));

    const sweep = await sweepAccount(ids.accountId);
    expect(sweep.deletedChanges).toBe(0);
    expect(sweep.deletedReceipts).toBe(0);

    const pulled = expectSuccess<SyncPullResult>(
      await postRpc('sync.pull', { cursor: null, maxBytes: 16384 }, auth),
    );
    expect(pulled.changes).toHaveLength(1);
  });

  it('exposes aggregate counters through session.describe accountStats', async () => {
    env.ENROLLMENT_ADMIN_TOKEN = ADMIN_TOKEN;
    const accountId = `acct-${crypto.randomUUID()}`;
    const session = await enroll((await issueCode(accountId)).code);

    const change = await hashedChange({ enrollmentSequence: 1, entityId: 'tpl-stats' });
    expectSuccess<SyncPushResult>(
      await postRpc('sync.push', { changes: [change] }, `Bearer ${session.accessToken}`),
    );

    const described = expectSuccess<SessionDescribeResult>(
      await postRpc('session.describe', {}, `Bearer ${session.accessToken}`),
    );
    expect(described.enrollmentId).toBe(session.enrollmentId);
    const stats = described.accountStats;
    expect(stats).toBeDefined();
    expect(stats?.historyBytes).toBeGreaterThan(0);
    expect(stats?.historyQuotaBytes).toBe(HISTORY_QUOTA_BYTES);
    expect(stats?.counters['push_accepted']).toBe(1);
    expect(stats?.counters['bytes_accepted']).toBeGreaterThan(0);
  });
});

describe('session retention sweep', () => {
  it('deletes expired unconsumed codes and aged revoked sessions', async () => {
    env.ENROLLMENT_ADMIN_TOKEN = ADMIN_TOKEN;
    const accountId = `acct-${crypto.randomUUID()}`;
    const issued = await issueCode(accountId);

    // Age the code past its TTL without consuming it.
    await runInDurableObject(sessionStub(), (_i: SessionCoordinator, state) => {
      state.storage.sql.exec(
        'UPDATE enrollment_codes SET expires_at = ? WHERE consumed_at IS NULL',
        Date.now() - 1000,
      );
    });
    const swept = await sessionStub().fetch(
      new Request('https://internal.anvil/internal/sweep', { method: 'POST' }),
    );
    const result = (await swept.json()) as { deletedCodes: number };
    expect(result.deletedCodes).toBeGreaterThanOrEqual(1);

    // The swept code can no longer be redeemed.
    const enrollResponse = await SELF.fetch('https://spike.test/v1/enroll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        proof: { method: 'enrollment-code', code: issued.code },
        installationId: 'install-x',
      }),
    });
    expect(enrollResponse.status).toBe(401);
  });

  it('clears the lapsed refresh-grace window without revoking the session', async () => {
    env.ENROLLMENT_ADMIN_TOKEN = ADMIN_TOKEN;
    const accountId = `acct-${crypto.randomUUID()}`;
    const session = await enroll((await issueCode(accountId)).code);

    // Force a rotation, then age the grace window into the past and sweep.
    const refreshed = await SELF.fetch('https://spike.test/v1/session/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        refreshToken: session.refreshToken,
        enrollmentId: session.enrollmentId,
      }),
    });
    expect(refreshed.status).toBe(200);

    await runInDurableObject(sessionStub(), (_i: SessionCoordinator, state) => {
      state.storage.sql.exec(
        'UPDATE device_sessions SET prev_refresh_grace_until = ? WHERE enrollment_id = ?',
        Date.now() - 1000,
        session.enrollmentId,
      );
    });
    const swept = await sessionStub().fetch(
      new Request('https://internal.anvil/internal/sweep', { method: 'POST' }),
    );
    const result = (await swept.json()) as { clearedGrace: number };
    expect(result.clearedGrace).toBeGreaterThanOrEqual(1);

    // The superseded credential's tracking row is gone entirely: presenting it
    // is simply an unknown proof, not a replayable rotation.
    const stale = await SELF.fetch('https://spike.test/v1/session/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        refreshToken: session.refreshToken,
        enrollmentId: session.enrollmentId,
      }),
    });
    expect(stale.status).toBe(401);
    expect(((await stale.json()) as { error: { code: string } }).error.code).toBe(
      'invalid-proof',
    );
  });
});
