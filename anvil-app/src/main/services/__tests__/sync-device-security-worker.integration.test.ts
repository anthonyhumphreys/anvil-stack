import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SCHEMA_SQL } from '../../db/schema';
import type { DeviceSession, EnrollmentCodeIssueResult } from '../../../../cloud/contract/auth';
import type { SyncScope } from '../../../shared/sync-mesh';

const { active } = vi.hoisted(() => ({ active: { db: null as Database.Database | null } }));

vi.mock('../../db/database.js', () => ({
  getDb: () => {
    if (active.db === null) throw new Error('integration test database is not active');
    return active.db;
  },
}));
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`enc:${value}`, 'utf8'),
    decryptString: (encrypted: Buffer) => {
      const text = encrypted.toString('utf8');
      if (!text.startsWith('enc:')) throw new Error('invalid wrapped value');
      return text.slice('enc:'.length);
    },
  },
}));
vi.mock('../sync-entity-domain.js', () => ({ applyRemoteEntityPayload: vi.fn() }));

import { rpc as backendRpc, postAuthRoute } from '../sync-backend-client.service';
import {
  currentAccountKey,
  exportAccountKeyBundle,
  provisionAccountKey,
  rotateAccountKey,
  sealScopedJson,
  unsealScopedJson,
} from '../sync-keyring.service';
import {
  getDeviceSecurityStatus,
  replaceDeviceRecovery,
  setNewDeviceTrustPolicy,
  setupDeviceRecovery,
  unlockDeviceRecovery,
} from '../sync-device-security.service';

const origin = (process.env['ANVIL_SECURITY_TEST_ORIGIN'] ?? '').trim().replace(/\/$/, '');
const adminToken = process.env['ANVIL_SECURITY_TEST_ADMIN_TOKEN'] ?? 'dev-admin-token';
const liveWorker = /^http:\/\/127\.0\.0\.1:\d+$/.test(origin);
const describeWorker = liveWorker ? describe : describe.skip;

const backendId = 'worker-security-integration';
const connection = { apiUrl: `${origin}/v1/` };
const transmitted: Array<{ operation: string; params: unknown }> = [];
let deviceA: Database.Database;
let deviceB: Database.Database;
let deviceC: Database.Database;

function createDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  return db;
}

function scope(session: DeviceSession): SyncScope {
  return {
    backendId,
    accountId: session.accountId,
    datasetEpoch: session.datasetEpoch,
  };
}

function context(session: DeviceSession, currentScope: SyncScope) {
  return {
    scope: currentScope,
    enrollmentId: session.enrollmentId,
    rpc: async <R>(operation: string, params: unknown): Promise<R> => {
      transmitted.push({ operation, params });
      const { result } = await backendRpc<R>(connection, operation, params, session.accessToken);
      return result;
    },
    assertCurrent: () => undefined,
  };
}

async function issueEnrollmentCode(accountId: string): Promise<string> {
  const result = await postAuthRoute<EnrollmentCodeIssueResult>(
    connection,
    'enrollment-codes',
    { accountId },
    { accessToken: adminToken },
  );
  return result.code;
}

async function enroll(code: string, installationId: string): Promise<DeviceSession> {
  return postAuthRoute<DeviceSession>(connection, 'enroll', {
    proof: { method: 'enrollment-code', code },
    installationId,
    displayName: installationId,
  });
}

async function approve(caller: DeviceSession, enrollmentId: string): Promise<void> {
  transmitted.push({
    operation: 'security.approve',
    params: { enrollmentId, source: 'manual-approval' },
  });
  await backendRpc(
    connection,
    'security.approve',
    { enrollmentId, source: 'manual-approval' },
    caller.accessToken,
  );
}

beforeEach(() => {
  transmitted.length = 0;
  deviceA = createDb();
  deviceB = createDb();
  deviceC = createDb();
  active.db = deviceA;
});

afterEach(() => {
  active.db = null;
  deviceA.close();
  deviceB.close();
  deviceC.close();
});

describeWorker('live Worker device security orchestration', () => {
  it('enrolls, recovers, rotates, replaces, and recovers key history end to end', async () => {
    const accountId = `acct-worker-security-${crypto.randomUUID()}`;
    const first = await enroll(await issueEnrollmentCode(accountId), 'worker-security-a');
    const scopeA = scope(first);
    provisionAccountKey(scopeA);

    const setup = await setupDeviceRecovery(context(first, scopeA), 'auto-trust-authenticated');
    expect(setup.recoveryCode).toMatch(/^anvil-recovery-[A-Za-z0-9_-]{43}$/);
    const initialStatus = await getDeviceSecurityStatus(context(first, scopeA));
    expect(initialStatus.policy).toBe('auto-trust-authenticated');
    expect(initialStatus.hasRecoverySecret).toBe(true);

    const second = await enroll(await issueEnrollmentCode(accountId), 'worker-security-b');
    const scopeB = scope(second);
    active.db = deviceA;
    await approve(first, second.enrollmentId);

    active.db = deviceB;
    await expect(
      unlockDeviceRecovery(context(second, scopeB), `${setup.recoveryCode}x`),
    ).rejects.toThrow();
    expect(transmitted.some((entry) => entry.operation === 'security.recover')).toBe(false);
    expect(currentAccountKey(scopeB)).toBeNull();

    const original = { title: 'opaque worker payload', marker: crypto.randomUUID() };
    active.db = deviceA;
    const sealed = sealScopedJson(scopeA, 'integration/device-security', original);
    const accountBundle = exportAccountKeyBundle(scopeA);
    expect(accountBundle).not.toBeNull();

    active.db = deviceB;
    const recoveredStatus = await unlockDeviceRecovery(context(second, scopeB), setup.recoveryCode);
    expect(recoveredStatus.hasAccountKey).toBe(true);
    expect(unsealScopedJson(scopeB, 'integration/device-security', sealed)).toEqual(original);

    await setNewDeviceTrustPolicy(context(second, scopeB), 'require-approval');
    const autoStatus = await setNewDeviceTrustPolicy(
      context(second, scopeB),
      'auto-trust-authenticated',
    );
    expect(autoStatus.policy).toBe('auto-trust-authenticated');

    // Revoking A invalidates the existing recovery root. B rotates locally,
    // then replacement must include the new key version before it commits a
    // fresh root.
    transmitted.push({ operation: 'device.revoke', params: { enrollmentId: first.enrollmentId } });
    await backendRpc(
      connection,
      'device.revoke',
      { enrollmentId: first.enrollmentId },
      second.accessToken,
    );
    rotateAccountKey(scopeB, [first.enrollmentId]);
    expect(currentAccountKey(scopeB)?.version).toBe(2);
    const rotated = sealScopedJson(scopeB, 'integration/device-security', {
      afterRevocation: true,
    });
    const rotatedBundle = exportAccountKeyBundle(scopeB);
    const replacement = await replaceDeviceRecovery(context(second, scopeB));
    expect(replacement.recoveryCode).toMatch(/^anvil-recovery-[A-Za-z0-9_-]{43}$/);
    expect(replacement.recoveryCode).not.toBe(setup.recoveryCode);

    const third = await enroll(await issueEnrollmentCode(accountId), 'worker-security-c');
    const scopeC = scope(third);
    active.db = deviceB;
    await approve(second, third.enrollmentId);
    active.db = deviceC;
    await expect(
      unlockDeviceRecovery(context(third, scopeC), setup.recoveryCode),
    ).rejects.toThrow();
    expect(currentAccountKey(scopeC)).toBeNull();
    const finalStatus = await unlockDeviceRecovery(
      context(third, scopeC),
      replacement.recoveryCode,
    );
    expect(finalStatus.hasAccountKey).toBe(true);
    expect(exportAccountKeyBundle(scopeC)?.keys.map((entry) => entry.keyVersion)).toEqual([1, 2]);
    expect(unsealScopedJson(scopeC, 'integration/device-security', sealed)).toEqual(original);
    expect(unsealScopedJson(scopeC, 'integration/device-security', rotated)).toEqual({
      afterRevocation: true,
    });

    const sensitiveValues = [
      setup.recoveryCode,
      replacement.recoveryCode,
      setup.recoveryCode.slice('anvil-recovery-'.length),
      replacement.recoveryCode.slice('anvil-recovery-'.length),
      ...(accountBundle?.keys.map((entry) => entry.adk) ?? []),
      ...(rotatedBundle?.keys.map((entry) => entry.adk) ?? []),
    ];
    const wire = JSON.stringify(transmitted);
    for (const value of sensitiveValues) expect(wire).not.toContain(value);
  }, 30_000);
});
